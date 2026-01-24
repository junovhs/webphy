//! Vulkan instance creation with validation layer support.

use crate::error::{PalResult, VulkanError};
use ash::{ext, khr, vk, Entry};
use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
use std::ffi::CStr;
use tracing::{debug, info, warn};

/// Wrapper around Vulkan instance with debug utilities.
pub struct VulkanInstance {
    entry: Entry,
    instance: ash::Instance,
    debug_utils: Option<DebugUtils>,
    surface_loader: khr::surface::Instance,
}

struct DebugUtils {
    loader: ext::debug_utils::Instance,
    messenger: vk::DebugUtilsMessengerEXT,
}

impl VulkanInstance {
    /// Creates a new Vulkan instance with optional validation.
    pub fn new(display: &impl HasDisplayHandle, enable_validation: bool) -> PalResult<Self> {
        // SAFETY: Entry::load loads the Vulkan library dynamically
        let entry = unsafe { Entry::load() }
            .map_err(|e| VulkanError::InstanceCreation(e.to_string()))?;

        let app_info = vk::ApplicationInfo::default()
            .application_name(c"NITRATE")
            .application_version(vk::make_api_version(0, 0, 1, 0))
            .engine_name(c"nitrate-pal")
            .engine_version(vk::make_api_version(0, 0, 1, 0))
            .api_version(vk::API_VERSION_1_2);

        let extensions = build_instance_extensions(&entry, display)?;
        let layers = build_layers(&entry, enable_validation);

        let create_info = vk::InstanceCreateInfo::default()
            .application_info(&app_info)
            .enabled_extension_names(&extensions)
            .enabled_layer_names(&layers);

        // SAFETY: create_info is valid for the duration of this call
        let instance = unsafe { entry.create_instance(&create_info, None) }
            .map_err(VulkanError::Api)?;

        info!("Vulkan instance created (validation: {})", enable_validation);

        let debug_utils = if enable_validation {
            create_debug_messenger(&entry, &instance).ok()
        } else {
            None
        };

        let surface_loader = khr::surface::Instance::new(&entry, &instance);

        Ok(Self { entry, instance, debug_utils, surface_loader })
    }

    /// Returns reference to raw ash instance.
    pub fn raw(&self) -> &ash::Instance { &self.instance }

    /// Returns reference to entry point.
    pub fn entry(&self) -> &Entry { &self.entry }

    /// Returns reference to surface loader.
    pub fn surface_loader(&self) -> &khr::surface::Instance { &self.surface_loader }
}

impl Drop for VulkanInstance {
    fn drop(&mut self) {
        // SAFETY: We own these resources and are destroying them in correct order
        unsafe {
            if let Some(debug) = self.debug_utils.take() {
                debug.loader.destroy_debug_utils_messenger(debug.messenger, None);
            }
            self.instance.destroy_instance(None);
        }
        debug!("Vulkan instance destroyed");
    }
}

fn build_instance_extensions(
    entry: &Entry,
    display: &impl HasDisplayHandle,
) -> PalResult<Vec<*const i8>> {
    let mut extensions = vec![khr::surface::NAME.as_ptr()];

    // Platform-specific surface extension
    let display_handle = display.display_handle()
        .map_err(|e| VulkanError::InstanceCreation(e.to_string()))?;

    let platform_ext = match display_handle.as_raw() {
        RawDisplayHandle::Xlib(_) => khr::xlib_surface::NAME,
        RawDisplayHandle::Xcb(_) => khr::xcb_surface::NAME,
        RawDisplayHandle::Wayland(_) => khr::wayland_surface::NAME,
        _ => return Err(VulkanError::InstanceCreation("Unsupported display".into()).into()),
    };
    extensions.push(platform_ext.as_ptr());

    // Debug utils if available
    let available = entry.enumerate_instance_extension_properties(None)
        .map_err(VulkanError::Api)?;

    let has_debug = available.iter().any(|ext| {
        // SAFETY: Vulkan spec guarantees null-terminated extension_name
        let name = unsafe { CStr::from_ptr(ext.extension_name.as_ptr()) };
        name == ext::debug_utils::NAME
    });

    if has_debug {
        extensions.push(ext::debug_utils::NAME.as_ptr());
    }

    Ok(extensions)
}

fn build_layers(entry: &Entry, enable_validation: bool) -> Vec<*const i8> {
    if !enable_validation {
        return vec![];
    }

    let validation_layer = c"VK_LAYER_KHRONOS_validation";

    let available = entry.enumerate_instance_layer_properties()
        .unwrap_or_default();

    let has_validation = available.iter().any(|layer| {
        // SAFETY: Vulkan spec guarantees null-terminated layer_name
        let name = unsafe { CStr::from_ptr(layer.layer_name.as_ptr()) };
        name == validation_layer
    });

    if has_validation {
        info!("Validation layers enabled");
        vec![validation_layer.as_ptr()]
    } else {
        warn!("Validation layers requested but not available");
        vec![]
    }
}

fn create_debug_messenger(
    entry: &Entry,
    instance: &ash::Instance,
) -> PalResult<DebugUtils> {
    let loader = ext::debug_utils::Instance::new(entry, instance);

    let create_info = vk::DebugUtilsMessengerCreateInfoEXT::default()
        .message_severity(
            vk::DebugUtilsMessageSeverityFlagsEXT::WARNING
            | vk::DebugUtilsMessageSeverityFlagsEXT::ERROR,
        )
        .message_type(
            vk::DebugUtilsMessageTypeFlagsEXT::GENERAL
            | vk::DebugUtilsMessageTypeFlagsEXT::VALIDATION
            | vk::DebugUtilsMessageTypeFlagsEXT::PERFORMANCE,
        )
        .pfn_user_callback(Some(debug_callback));

    // SAFETY: create_info is valid and callback is extern "system"
    let messenger = unsafe { loader.create_debug_utils_messenger(&create_info, None) }
        .map_err(VulkanError::Api)?;

    Ok(DebugUtils { loader, messenger })
}

unsafe extern "system" fn debug_callback(
    severity: vk::DebugUtilsMessageSeverityFlagsEXT,
    _ty: vk::DebugUtilsMessageTypeFlagsEXT,
    data: *const vk::DebugUtilsMessengerCallbackDataEXT<'_>,
    _user: *mut std::ffi::c_void,
) -> vk::Bool32 {
    // SAFETY: Vulkan guarantees data is valid and p_message is null-terminated
    let msg = unsafe { CStr::from_ptr((*data).p_message) }.to_string_lossy();

    if severity.contains(vk::DebugUtilsMessageSeverityFlagsEXT::ERROR) {
        tracing::error!(target: "vulkan", "{}", msg);
    } else {
        tracing::warn!(target: "vulkan", "{}", msg);
    }

    vk::FALSE
}

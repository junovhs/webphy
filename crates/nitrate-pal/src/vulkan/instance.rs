//! Vulkan instance creation with validation layer support.

#![allow(clippy::manual_c_str_literals)]

use crate::error::{PalResult, VulkanError};
use ash::{ext, khr, vk, Entry};
use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
use std::ffi::CStr;
use tracing::{debug, info, warn};

/// Wrapper around Vulkan instance with debug utilities.
pub struct VulkanInstance {
    pub entry: Entry,
    pub instance: ash::Instance,
    debug_utils: Option<DebugUtils>,
    pub surface_loader: khr::surface::Instance,
}

struct DebugUtils {
    loader: ext::debug_utils::Instance,
    messenger: vk::DebugUtilsMessengerEXT,
}

impl VulkanInstance {
    /// Creates a new Vulkan instance with optional validation.
    pub fn new(display: &impl HasDisplayHandle, enable_validation: bool) -> PalResult<Self> {
        // SAFETY: Entry::load loads the Vulkan library dynamically. This is safe
        // as long as a valid Vulkan loader is installed on the system.
        let entry = unsafe { Entry::load() }
            .map_err(|e| VulkanError::InstanceCreation(e.to_string()))?;

        let app_name = CStr::from_bytes_with_nul(b"NITRATE\0")
            .map_err(|e| VulkanError::InstanceCreation(e.to_string()))?;
        let engine_name = CStr::from_bytes_with_nul(b"nitrate-pal\0")
            .map_err(|e| VulkanError::InstanceCreation(e.to_string()))?;

        let app_info = vk::ApplicationInfo::default()
            .application_name(app_name)
            .application_version(vk::make_api_version(0, 0, 1, 0))
            .engine_name(engine_name)
            .engine_version(vk::make_api_version(0, 0, 1, 0))
            .api_version(vk::API_VERSION_1_2);

        let extensions = build_instance_extensions(&entry, display)?;
        let layers = build_layers(&entry, enable_validation)?;

        let create_info = vk::InstanceCreateInfo::default()
            .application_info(&app_info)
            .enabled_extension_names(&extensions)
            .enabled_layer_names(&layers);

        // SAFETY: create_info is valid for the duration of this call.
        // All pointers in create_info reference valid memory.
        let instance = unsafe { entry.create_instance(&create_info, None) }
            .map_err(VulkanError::Api)?;

        info!("Vulkan instance created (validation: {})", enable_validation);

        let debug_utils = if enable_validation {
            create_debug_messenger(&entry, &instance).ok()
        } else {
            None
        };

        let surface_loader = khr::surface::Instance::new(&entry, &instance);

        Ok(Self {
            entry,
            instance,
            debug_utils,
            surface_loader,
        })
    }
}

impl Drop for VulkanInstance {
    fn drop(&mut self) {
        // SAFETY: We own these resources and are destroying them in correct order.
        // Debug messenger must be destroyed before instance.
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

    let display_handle = display
        .display_handle()
        .map_err(|e| VulkanError::InstanceCreation(e.to_string()))?;

    let platform_ext = match display_handle.as_raw() {
        RawDisplayHandle::Xlib(_) => khr::xlib_surface::NAME,
        RawDisplayHandle::Xcb(_) => khr::xcb_surface::NAME,
        RawDisplayHandle::Wayland(_) => khr::wayland_surface::NAME,
        _ => return Err(VulkanError::InstanceCreation("Unsupported display".into()).into()),
    };
    extensions.push(platform_ext.as_ptr());

    // SAFETY: entry is valid. enumerate_instance_extension_properties queries
    // the Vulkan loader for available extensions, which is a safe operation.
    let available = unsafe { entry.enumerate_instance_extension_properties(None) }
        .map_err(VulkanError::Api)?;

    let has_debug = available.iter().any(|ext| {
        // SAFETY: Vulkan spec guarantees extension_name is null-terminated
        let name = unsafe { CStr::from_ptr(ext.extension_name.as_ptr()) };
        name == ext::debug_utils::NAME
    });

    if has_debug {
        extensions.push(ext::debug_utils::NAME.as_ptr());
    }

    Ok(extensions)
}

fn build_layers(entry: &Entry, enable_validation: bool) -> PalResult<Vec<*const i8>> {
    if !enable_validation {
        return Ok(vec![]);
    }

    let validation_layer = CStr::from_bytes_with_nul(b"VK_LAYER_KHRONOS_validation\0")
        .map_err(|e| VulkanError::InstanceCreation(e.to_string()))?;

    // SAFETY: entry is valid. enumerate_instance_layer_properties queries
    // the Vulkan loader for available layers, which is a safe operation.
    let available = unsafe { entry.enumerate_instance_layer_properties() }
        .unwrap_or_default();

    let has_validation = available.iter().any(|layer| {
        // SAFETY: Vulkan spec guarantees layer_name is null-terminated
        let name = unsafe { CStr::from_ptr(layer.layer_name.as_ptr()) };
        name == validation_layer
    });

    if has_validation {
        info!("Validation layers enabled");
        Ok(vec![validation_layer.as_ptr()])
    } else {
        warn!("Validation layers requested but not available");
        Ok(vec![])
    }
}

fn create_debug_messenger(entry: &Entry, instance: &ash::Instance) -> PalResult<DebugUtils> {
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

    // SAFETY: create_info is valid with a valid extern "system" callback function.
    // The callback does not capture any external state.
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
    // for the duration of this callback.
    let msg = unsafe { CStr::from_ptr((*data).p_message) }.to_string_lossy();

    if severity.contains(vk::DebugUtilsMessageSeverityFlagsEXT::ERROR) {
        tracing::error!(target: "vulkan", "{}", msg);
    } else {
        tracing::warn!(target: "vulkan", "{}", msg);
    }

    vk::FALSE
}
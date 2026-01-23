use crate::params::{self, ParamDef};
use dioxus::prelude::*;
use tracing::{error, info};

#[component]
pub fn Sidebar(image_path: Signal<Option<String>>) -> Element {
    let mut exposure = use_signal(|| params::EXPOSURE.default);
    let mut grain = use_signal(|| params::GRAIN.default);
    let mut halation = use_signal(|| params::HALATION.default);

    let open_image = move |_| {
        spawn(async move {
            let file = rfd::AsyncFileDialog::new()
                .add_filter("Images", &["png", "jpg", "jpeg"])
                .pick_file()
                .await;

            if let Some(file) = file {
                let path = file.path().to_string_lossy().to_string();
                info!("Opening: {path}");
                image_path.set(Some(path));
            }
        });
    };

    rsx! {
        aside { class: "sidebar",
            div { class: "sidebar-header",
                h1 { "NITRATE" }
                span { class: "tagline", "Volatile Memory" }
            }

            div { class: "controls",
                ControlGroup {
                    label: "Exposure",
                    param: params::EXPOSURE,
                    value: exposure(),
                    uniform_name: "exposure",
                    on_change: move |v| exposure.set(v),
                }
                ControlGroup {
                    label: "Film Grain",
                    param: params::GRAIN,
                    value: grain(),
                    uniform_name: "grain",
                    on_change: move |v| grain.set(v),
                }
                ControlGroup {
                    label: "Halation",
                    param: params::HALATION,
                    value: halation(),
                    uniform_name: "halation",
                    on_change: move |v| halation.set(v),
                }
            }

            div { class: "sidebar-footer",
                button {
                    class: "btn btn-primary",
                    onclick: open_image,
                    "Open Image"
                }
                button { class: "btn", "Export" }
            }
        }
    }
}

#[component]
fn ControlGroup(
    label: &'static str,
    param: ParamDef,
    value: f32,
    uniform_name: &'static str,
    on_change: EventHandler<f32>,
) -> Element {
    rsx! {
        div { class: "control-group",
            label { "{label}" }
            input {
                r#type: "range",
                min: param.min,
                max: param.max,
                step: param.step,
                value: value,
                oninput: move |e| {
                    if let Ok(v) = e.value().parse::<f32>() {
                        let clamped = param.clamp(v);
                        on_change.call(clamped);
                        // Update WebGL uniform
                        let js = format!("window.Renderer && window.Renderer.setUniform('{uniform_name}', {clamped})");
                        eval(&js);
                    }
                },
            }
            span { class: "value", "{value:.2}" }
        }
    }
}
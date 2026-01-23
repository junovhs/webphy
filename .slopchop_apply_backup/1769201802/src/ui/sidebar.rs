use dioxus::prelude::*;
use crate::params::{self, ParamDef};

#[component]
pub fn Sidebar() -> Element {
    let mut exposure = use_signal(|| params::EXPOSURE.default);
    let mut grain = use_signal(|| params::GRAIN.default);
    let mut halation = use_signal(|| params::HALATION.default);

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
                    on_change: move |v| exposure.set(v),
                }
                ControlGroup {
                    label: "Film Grain",
                    param: params::GRAIN,
                    value: grain(),
                    on_change: move |v| grain.set(v),
                }
                ControlGroup {
                    label: "Halation",
                    param: params::HALATION,
                    value: halation(),
                    on_change: move |v| halation.set(v),
                }
            }

            div { class: "sidebar-footer",
                button { class: "btn btn-primary", "Open Image" }
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
                        on_change.call(param.clamp(v));
                    }
                },
            }
            span { class: "value", "{value:.2}" }
        }
    }
}
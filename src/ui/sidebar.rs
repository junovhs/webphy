use dioxus::prelude::*;

#[component]
pub fn Sidebar() -> Element {
    // Placeholder state - will be real signals in Phase 5
    let mut exposure = use_signal(|| 0.0_f32);
    let mut grain = use_signal(|| 0.25_f32);
    let mut halation = use_signal(|| 0.15_f32);

    rsx! {
        aside { class: "sidebar",
            div { class: "sidebar-header",
                h1 { "NITRATE" }
                span { class: "tagline", "Volatile Memory" }
            }

            div { class: "controls",
                ControlGroup {
                    label: "Exposure",
                    value: exposure(),
                    min: -3.0,
                    max: 3.0,
                    step: 0.1,
                    on_change: move |v| exposure.set(v),
                }
                ControlGroup {
                    label: "Film Grain",
                    value: grain(),
                    min: 0.0,
                    max: 1.0,
                    step: 0.01,
                    on_change: move |v| grain.set(v),
                }
                ControlGroup {
                    label: "Halation",
                    value: halation(),
                    min: 0.0,
                    max: 1.0,
                    step: 0.01,
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
    value: f32,
    min: f32,
    max: f32,
    step: f32,
    on_change: EventHandler<f32>,
) -> Element {
    rsx! {
        div { class: "control-group",
            label { "{label}" }
            input {
                r#type: "range",
                min: min,
                max: max,
                step: step,
                value: value,
                oninput: move |e| {
                    if let Ok(v) = e.value().parse::<f32>() {
                        on_change.call(v);
                    }
                },
            }
            span { class: "value", "{value:.2}" }
        }
    }
}

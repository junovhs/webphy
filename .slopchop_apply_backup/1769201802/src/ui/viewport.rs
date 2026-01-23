use dioxus::prelude::*;

#[component]
pub fn Viewport() -> Element {
    rsx! {
        main { class: "viewport",
            div { class: "canvas-container",
                div { class: "canvas-placeholder",
                    div { class: "placeholder-content",
                        span { class: "icon", "?" }
                        p { "Drop an image here" }
                        p { class: "hint", "or click Open Image" }
                    }
                }
            }
            div { class: "viewport-footer",
                span { "Ready" }
                span { "1280 x 800" }
            }
        }
    }
}
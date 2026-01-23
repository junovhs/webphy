use dioxus::prelude::*;

#[component]
pub fn Viewport(image_data: Signal<Option<String>>) -> Element {
    let has_image = image_data.read().is_some();

    rsx! {
        main { class: "viewport",
            div { class: "canvas-container",
                if has_image {
                    img {
                        class: "preview-image",
                        src: image_data.read().as_ref().unwrap(),
                        alt: "Preview"
                    }
                } else {
                    div { class: "canvas-placeholder",
                        div { class: "placeholder-content",
                            span { class: "icon", "?" }
                            p { "Drop an image here" }
                            p { class: "hint", "or click Open Image" }
                        }
                    }
                }
            }
            div { class: "viewport-footer",
                span { if has_image { "Image loaded" } else { "Ready" } }
                span { "1280 x 800" }
            }
        }
    }
}
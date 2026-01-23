use dioxus::prelude::*;

#[component]
pub fn Viewport(image_data: Signal<Option<String>>) -> Element {
    let data = image_data.read();

    rsx! {
        main { class: "viewport",
            div { class: "canvas-container",
                match data.as_ref() {
                    Some(src) => rsx! {
                        img {
                            class: "preview-image",
                            src: "{src}",
                            alt: "Preview"
                        }
                    },
                    None => rsx! {
                        div { class: "canvas-placeholder",
                            div { class: "placeholder-content",
                                span { class: "icon", "?" }
                                p { "Drop an image here" }
                                p { class: "hint", "or click Open Image" }
                            }
                        }
                    }
                }
            }
            div { class: "viewport-footer",
                span { if data.is_some() { "Image loaded" } else { "Ready" } }
                span { "1280 x 800" }
            }
        }
    }
}
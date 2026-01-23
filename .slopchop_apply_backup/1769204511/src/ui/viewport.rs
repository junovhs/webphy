use dioxus::prelude::*;

#[component]
pub fn Viewport(image_path: Signal<Option<String>>) -> Element {
    let has_image = image_path.read().is_some();

    // Initialize renderer when component mounts
    use_effect(move || {
        eval("window.Renderer && window.Renderer.init('viewport-canvas')");
    });

    // Load image when path changes
    use_effect(move || {
        if let Some(path) = image_path.read().as_ref() {
            let escaped = path.replace('\\', "\\\\").replace('\'', "\\'");
            let js = format!("window.Renderer && window.Renderer.loadImage('file:///{escaped}')");
            eval(&js);
        }
    });

    rsx! {
        main { class: "viewport",
            div { class: "canvas-container",
                if has_image {
                    canvas {
                        id: "viewport-canvas",
                        class: "render-canvas"
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
use dioxus::document::eval;
use dioxus::prelude::*;

#[component]
pub fn Viewport(image_path: Signal<Option<String>>) -> Element {
    let has_image = image_path.read().is_some();

    use_effect(move || {
        if let Some(path) = image_path.read().as_ref() {
            let escaped = path.replace('\\', "/");
            let js = format!(
                r#"
                setTimeout(() => {{
                    if (!window.Renderer.gl) {{
                        window.Renderer.init('viewport-canvas');
                    }}
                    window.Renderer.loadImage('file:///{escaped}');
                }}, 50);
                "#
            );
            eval(&js);
        }
    });

    rsx! {
        main { class: "viewport",
            div { class: "canvas-container",
                if has_image {
                    canvas {
                        id: "viewport-canvas",
                        class: "render-canvas",
                        width: "800",
                        height: "600"
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
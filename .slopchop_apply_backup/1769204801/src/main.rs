#![allow(non_snake_case)]

mod params;
mod ui;

use dioxus::desktop::{Config, WindowBuilder};
use dioxus::prelude::*;
use tracing::info;

const MAIN_CSS: &str = include_str!("../assets/css/main.css");

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("nitrate=debug")
        .init();

    info!("NITRATE - Volatile Memory");

    let config = Config::new()
        .with_window(
            WindowBuilder::new()
                .with_title("NITRATE")
                .with_inner_size(dioxus::desktop::LogicalSize::new(1280.0, 800.0))
                .with_min_inner_size(dioxus::desktop::LogicalSize::new(900.0, 600.0)),
        )
        .with_disable_context_menu(true);

    dioxus::LaunchBuilder::desktop()
        .with_cfg(config)
        .launch(App);
}

fn App() -> Element {
    let image_path: Signal<Option<String>> = use_signal(|| None);

    rsx! {
        style { {MAIN_CSS} }
        div { class: "app",
            ui::Sidebar { image_path }
            ui::Viewport { image_path }
        }
    }
}
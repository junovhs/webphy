use std::path::Path;

#[derive(Debug, Clone)]
pub struct ImageData {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ImageError {
    FileNotFound,
    DecodeFailed(String),
}

impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FileNotFound => write!(f, "File not found"),
            Self::DecodeFailed(msg) => write!(f, "Decode failed: {msg}"),
        }
    }
}

impl std::error::Error for ImageError {}

pub fn load_image<P: AsRef<Path>>(path: P) -> Result<ImageData, ImageError> {
    let path = path.as_ref();

    if !path.exists() {
        return Err(ImageError::FileNotFound);
    }

    let img = image::open(path)
        .map_err(|e| ImageError::DecodeFailed(e.to_string()))?
        .to_rgba8();

    let (width, height) = img.dimensions();
    let pixels = img.into_raw();

    Ok(ImageData { width, height, pixels })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_nonexistent_returns_error() {
        let result = load_image("/nonexistent/image.png");
        assert!(matches!(result, Err(ImageError::FileNotFound)));
    }

    #[test]
    fn load_valid_image_returns_rgba_data() {
        let dir = std::env::temp_dir();
        let path = dir.join("nitrate_test_load.png");

        let img = image::RgbImage::from_fn(8, 8, |x, y| {
            image::Rgb([(x * 32).min(255) as u8, (y * 32).min(255) as u8, 128])
        });
        img.save(&path).expect("save test image");

        let result = load_image(&path);
        assert!(result.is_ok());

        let data = result.unwrap();
        assert_eq!(data.width, 8);
        assert_eq!(data.height, 8);
        assert_eq!(data.pixels.len(), 8 * 8 * 4);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn image_error_display() {
        let err = ImageError::FileNotFound;
        assert_eq!(format!("{err}"), "File not found");
    }
}
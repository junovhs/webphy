use base64::Engine;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub enum ImageError {
    FileNotFound,
    InvalidFormat,
    ReadError(String),
}

impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FileNotFound => write!(f, "File not found"),
            Self::InvalidFormat => write!(f, "Invalid image format"),
            Self::ReadError(msg) => write!(f, "Read error: {msg}"),
        }
    }
}

impl std::error::Error for ImageError {}

/// Load an image file and return as base64 data URL for display.
/// Supports PNG and JPEG formats.
pub fn load_image_as_base64<P: AsRef<Path>>(path: P) -> Result<String, ImageError> {
    let path = path.as_ref();

    if !path.exists() {
        return Err(ImageError::FileNotFound);
    }

    let img = image::open(path).map_err(|e| ImageError::ReadError(e.to_string()))?;

    let mut buffer = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buffer);

    img.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| ImageError::ReadError(e.to_string()))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&buffer);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// Get image dimensions without loading full image.
pub fn get_image_dimensions<P: AsRef<Path>>(path: P) -> Result<(u32, u32), ImageError> {
    let path = path.as_ref();

    if !path.exists() {
        return Err(ImageError::FileNotFound);
    }

    let reader = image::ImageReader::open(path)
        .map_err(|e| ImageError::ReadError(e.to_string()))?;

    let dims = reader
        .into_dimensions()
        .map_err(|e| ImageError::ReadError(e.to_string()))?;

    Ok(dims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn create_test_png(path: &Path) {
        let img = image::RgbImage::from_fn(16, 16, |x, y| {
            image::Rgb([
                ((x * 16) % 256) as u8,
                ((y * 16) % 256) as u8,
                128u8,
            ])
        });
        img.save(path).expect("Failed to save test image");
    }

    fn create_invalid_file(path: &Path) {
        let mut f = std::fs::File::create(path).expect("create file");
        f.write_all(b"not an image").expect("write");
    }

    #[test]
    fn load_nonexistent_file_returns_file_not_found() {
        let result = load_image_as_base64("/nonexistent/path/image.png");
        assert!(matches!(result, Err(ImageError::FileNotFound)));
    }

    #[test]
    fn load_invalid_file_returns_read_error() {
        let dir = std::env::temp_dir();
        let path = dir.join("nitrate_test_invalid.txt");
        create_invalid_file(&path);

        let result = load_image_as_base64(&path);
        assert!(matches!(result, Err(ImageError::ReadError(_))));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn load_valid_png_returns_base64_data_url() {
        let dir = std::env::temp_dir();
        let path = dir.join("nitrate_test_valid.png");
        create_test_png(&path);

        let result = load_image_as_base64(&path);
        assert!(result.is_ok());

        let data_url = result.unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));
        assert!(data_url.len() > 30);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn get_dimensions_nonexistent_returns_error() {
        let result = get_image_dimensions("/nonexistent/image.png");
        assert!(matches!(result, Err(ImageError::FileNotFound)));
    }

    #[test]
    fn get_dimensions_returns_correct_size() {
        let dir = std::env::temp_dir();
        let path = dir.join("nitrate_test_dims.png");
        create_test_png(&path);

        let result = get_image_dimensions(&path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), (16, 16));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn image_error_display_file_not_found() {
        let err = ImageError::FileNotFound;
        assert_eq!(format!("{err}"), "File not found");
    }

    #[test]
    fn image_error_display_invalid_format() {
        let err = ImageError::InvalidFormat;
        assert_eq!(format!("{err}"), "Invalid image format");
    }

    #[test]
    fn image_error_display_read_error() {
        let err = ImageError::ReadError("test".to_string());
        assert_eq!(format!("{err}"), "Read error: test");
    }
}
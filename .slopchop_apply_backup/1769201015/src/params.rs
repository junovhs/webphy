/// Film simulation parameters with validation and defaults.
/// These drive the GPU uniforms in later phases.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParamDef {
    pub default: f32,
    pub min: f32,
    pub max: f32,
    pub step: f32,
}

impl ParamDef {
    /// Clamp a value to this parameter's valid range.
    #[must_use]
    pub fn clamp(&self, value: f32) -> f32 {
        value.clamp(self.min, self.max)
    }

    /// Check if a value is within the valid range.
    #[must_use]
    pub fn is_valid(&self, value: f32) -> bool {
        value >= self.min && value <= self.max
    }

    /// Normalize value to 0.0..1.0 range.
    #[must_use]
    pub fn normalize(&self, value: f32) -> f32 {
        if (self.max - self.min).abs() < f32::EPSILON {
            return 0.0;
        }
        (value - self.min) / (self.max - self.min)
    }

    /// Denormalize from 0.0..1.0 to parameter range.
    #[must_use]
    pub fn denormalize(&self, normalized: f32) -> f32 {
        self.min + normalized * (self.max - self.min)
    }
}

// === Parameter Definitions ===

pub const EXPOSURE: ParamDef = ParamDef {
    default: 0.0,
    min: -3.0,
    max: 3.0,
    step: 0.1,
};

pub const GRAIN: ParamDef = ParamDef {
    default: 0.25,
    min: 0.0,
    max: 1.0,
    step: 0.01,
};

pub const HALATION: ParamDef = ParamDef {
    default: 0.15,
    min: 0.0,
    max: 1.0,
    step: 0.01,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposure_default_is_valid() {
        assert!(EXPOSURE.is_valid(EXPOSURE.default));
    }

    #[test]
    fn grain_default_is_valid() {
        assert!(GRAIN.is_valid(GRAIN.default));
    }

    #[test]
    fn halation_default_is_valid() {
        assert!(HALATION.is_valid(HALATION.default));
    }

    #[test]
    fn clamp_below_min_returns_min() {
        assert!((EXPOSURE.clamp(-10.0) - EXPOSURE.min).abs() < f32::EPSILON);
        assert!((GRAIN.clamp(-5.0) - GRAIN.min).abs() < f32::EPSILON);
    }

    #[test]
    fn clamp_above_max_returns_max() {
        assert!((EXPOSURE.clamp(10.0) - EXPOSURE.max).abs() < f32::EPSILON);
        assert!((GRAIN.clamp(999.0) - GRAIN.max).abs() < f32::EPSILON);
    }

    #[test]
    fn clamp_within_range_unchanged() {
        let val = 1.5;
        assert!((EXPOSURE.clamp(val) - val).abs() < f32::EPSILON);
    }

    #[test]
    fn is_valid_rejects_out_of_range() {
        assert!(!EXPOSURE.is_valid(-3.1));
        assert!(!EXPOSURE.is_valid(3.1));
        assert!(!GRAIN.is_valid(-0.01));
        assert!(!GRAIN.is_valid(1.01));
    }

    #[test]
    fn is_valid_accepts_boundaries() {
        assert!(EXPOSURE.is_valid(EXPOSURE.min));
        assert!(EXPOSURE.is_valid(EXPOSURE.max));
        assert!(GRAIN.is_valid(GRAIN.min));
        assert!(GRAIN.is_valid(GRAIN.max));
    }

    #[test]
    fn normalize_maps_min_to_zero() {
        assert!(EXPOSURE.normalize(EXPOSURE.min).abs() < f32::EPSILON);
        assert!(GRAIN.normalize(GRAIN.min).abs() < f32::EPSILON);
    }

    #[test]
    fn normalize_maps_max_to_one() {
        assert!((EXPOSURE.normalize(EXPOSURE.max) - 1.0).abs() < f32::EPSILON);
        assert!((GRAIN.normalize(GRAIN.max) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn normalize_denormalize_roundtrip() {
        let values = [-2.0, 0.0, 1.5, 3.0];
        for &v in &values {
            let normalized = EXPOSURE.normalize(v);
            let restored = EXPOSURE.denormalize(normalized);
            assert!((restored - v).abs() < 1e-6, "roundtrip failed for {v}");
        }
    }

    #[test]
    fn denormalize_half_gives_midpoint() {
        let mid = EXPOSURE.denormalize(0.5);
        let expected = (EXPOSURE.min + EXPOSURE.max) / 2.0;
        assert!((mid - expected).abs() < f32::EPSILON);
    }

    #[test]
    fn normalize_handles_zero_range() {
        let zero_range = ParamDef {
            default: 5.0,
            min: 5.0,
            max: 5.0,
            step: 0.0,
        };
        // Should not divide by zero, returns 0.0
        assert!(zero_range.normalize(5.0).abs() < f32::EPSILON);
    }
}

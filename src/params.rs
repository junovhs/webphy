/// Film simulation parameters with validation and defaults.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParamDef {
    pub default: f32,
    pub min: f32,
    pub max: f32,
    pub step: f32,
}

impl ParamDef {
    #[must_use]
    pub fn clamp(&self, value: f32) -> f32 {
        value.clamp(self.min, self.max)
    }
}

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
    fn exposure_clamp_below_min_returns_min() {
        let result = EXPOSURE.clamp(-10.0);
        assert!((result - EXPOSURE.min).abs() < f32::EPSILON);
    }

    #[test]
    fn exposure_clamp_above_max_returns_max() {
        let result = EXPOSURE.clamp(10.0);
        assert!((result - EXPOSURE.max).abs() < f32::EPSILON);
    }

    #[test]
    fn exposure_clamp_within_range_unchanged() {
        let val = 1.5;
        let result = EXPOSURE.clamp(val);
        assert!((result - val).abs() < f32::EPSILON);
    }

    #[test]
    fn exposure_clamp_at_min_boundary() {
        let result = EXPOSURE.clamp(EXPOSURE.min);
        assert!((result - EXPOSURE.min).abs() < f32::EPSILON);
    }

    #[test]
    fn exposure_clamp_at_max_boundary() {
        let result = EXPOSURE.clamp(EXPOSURE.max);
        assert!((result - EXPOSURE.max).abs() < f32::EPSILON);
    }

    #[test]
    fn grain_clamp_below_min_returns_min() {
        let result = GRAIN.clamp(-5.0);
        assert!((result - GRAIN.min).abs() < f32::EPSILON);
    }

    #[test]
    fn grain_clamp_above_max_returns_max() {
        let result = GRAIN.clamp(999.0);
        assert!((result - GRAIN.max).abs() < f32::EPSILON);
    }

    #[test]
    fn halation_clamp_negative_returns_zero() {
        let result = HALATION.clamp(-0.5);
        assert!(result.abs() < f32::EPSILON);
    }

    #[test]
    fn clamp_midpoint_unchanged() {
        let mid = f32::midpoint(EXPOSURE.min, EXPOSURE.max);
        let result = EXPOSURE.clamp(mid);
        assert!((result - mid).abs() < f32::EPSILON);
    }
}
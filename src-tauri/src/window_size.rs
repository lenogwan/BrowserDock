//! Pure size policy shared by desktop commands and platform-independent tests.
use crate::config::Config;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
pub struct WindowSize {
    pub width: f64,
    pub height: Option<f64>,
}
impl Default for WindowSize {
    fn default() -> Self { Self { width:400.0, height:None } }
}
impl WindowSize {
    pub fn validate(&self) -> Result<(), String> {
        if !self.width.is_finite() || self.width <= 0.0 || self.height.is_some_and(|h| !h.is_finite() || h <= 0.0) {
            return Err("Dock size must be finite".into());
        }
        Ok(())
    }
    pub fn clamped(self, work_width:f64, work_height:f64) -> Result<Self,String> {
        self.validate()?;
        if !work_width.is_finite() || !work_height.is_finite() || work_width <= 0.0 || work_height <= 0.0 {
            return Err("Monitor work area unavailable".into());
        }
        // A work area smaller than the nominal minimum takes precedence.
        Ok(Self { width:self.width.clamp(280.0,800.0).min(work_width), height:self.height.map(|h| h.max(56.0).min(work_height)) })
    }
    pub fn from_value(value:Option<&Value>) -> (Self,bool) {
        let Some(value)=value else { return (Self::default(),false); };
        let mut warning=!value.is_object();
        let width=match value.get("width").and_then(Value::as_f64) {
            Some(w) if w.is_finite() && w > 0.0 => { warning |= !(280.0..=800.0).contains(&w); w.clamp(280.0,800.0) },
            _ => {warning=true;400.0}
        };
        let height=match value.get("height") {
            None | Some(Value::Null) => None,
            Some(v) => match v.as_f64() {
                Some(h) if h.is_finite() && h>0.0 => {warning |= h<56.0;Some(h.max(56.0))},
                _ => {warning=true;None}
            }
        };
        (Self {width,height},warning)
    }
}

pub struct SizeState {
    pub requested:WindowSize,
    auto_height:f64,
    strip:bool,
}
impl SizeState {
    pub fn new(requested:WindowSize) -> Self { Self { requested,auto_height:56.0,strip:false } }
    pub fn auto_fit(&mut self,height:f64,work_height:f64) -> Result<f64,String> {
        if !height.is_finite() || height<=0.0 { return Err("Dock size must be finite".into()); }
        self.strip=height<=6.0;
        if !self.strip { self.auto_height=height.clamp(56.0,560.0); }
        Ok(self.display_height(work_height))
    }
    pub fn display_height(&self,work_height:f64) -> f64 {
        // Manual height belongs to the expanded panel. Collapsing must shrink
        // the native window too, without overwriting that saved preference.
        (if self.strip {6.0}
         else if self.auto_height <= 56.0 {56.0}
         else {self.requested.height.unwrap_or(self.auto_height)}).min(work_height)
    }
    pub fn commit(&self,config:&Config,path:&Path,position:Value) -> Result<Config,String> {
        self.requested.validate()?;
        let mut next=config.clone();
        next.settings.insert("window_size".into(),serde_json::to_value(self.requested).map_err(|_| "Invalid window size")?);
        next.settings.insert("dock_position".into(),position);
        next.save(path)?;
        Ok(next)
    }
}

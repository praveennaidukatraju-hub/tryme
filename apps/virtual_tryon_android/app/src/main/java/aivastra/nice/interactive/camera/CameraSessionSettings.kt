package tryme.nice.interactive.camera

// Process-wide, in-memory only — deliberately not persisted to disk, so a customer's
// Capture Quality / HDR / Surface type / picture-size picks carry over while navigating
// between the camera and photo-edit screens within one visit, but reset to the defaults
// below the next time the app process is launched.
object CameraSessionSettings {
    var current: CameraSettings = CameraSettings()
}

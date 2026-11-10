// The probe's channels between its renderer and main sides.
export interface SurfaceProbeChannels {
  invoke: {
    /** A new surface with a local page (fixed 1280×800); its id. */
    create: () => string
  }
}

// The frame pads (F10b): two pads of the right side bar whose content is a frame like any other (tabs, empty panes,
// "+", splits, any pane type). The desk pad holds one frame per desk (switching desks swaps it); the global pad holds
// one frame shared by every desk. The core hosts the frames (TetherUi.pads.frames); this extension only declares them.
// The pad ids are in people's layout.json and never change.
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'frame-pads',
  version: '1.0.0',
  displayName: 'Pranchetas',
  description: 'Prancheta da mesa (um quadro por mesa) e prancheta global (um quadro para todas as mesas), na barra lateral.',
  hosts: ['renderer'],
  optional: true,
  contributes: {
    pads: [
      { id: 'frame-pads.desk', title: 'Prancheta da mesa', icon: 'clipboard-text', defaultSide: 'right', scope: 'desk', frames: true, absorbsHeader: true, order: 10 },
      { id: 'frame-pads.global', title: 'Prancheta global', icon: 'globe-simple', defaultSide: 'right', scope: 'global', frames: true, absorbsHeader: true, order: 20 },
    ],
  },
}

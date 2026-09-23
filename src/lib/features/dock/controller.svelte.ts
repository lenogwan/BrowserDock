import { invokeSizeCommand } from '../../platform/tauri/commands';
import { createSizeController } from './resize.js';

export class WindowController {
  native = $state(false);
  ready = $state(false);
  expanded = $state(false);
  strip = $state(false);
  dockVisible = $state(true);

  size = createSizeController((command, args) =>
    this.native
      ? invokeSizeCommand(command, args)
      : Promise.reject('Open the desktop app to resize the dock.'),
  );
}

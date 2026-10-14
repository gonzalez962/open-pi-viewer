import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFileDropZone } from '@features/chat/file-drop-zone';

class Zone extends EventTarget {
  classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
}
function drag(type: string, types = ['Files']) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { dataTransfer: { types, dropEffect: '' } });
  return event as DragEvent;
}

test('history and prompt share one drop zone, including nested transitions and cleanup', () => {
  const zone = new Zone();
  let dropped = 0;
  const unbind = bindFileDropZone(zone as unknown as HTMLElement, true, () => dropped++);
  const enter = drag('dragenter');
  zone.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(zone.classes.has('prompt-file-dragover'), true);
  zone.dispatchEvent(drag('dragenter'));
  zone.dispatchEvent(drag('dragleave'));
  assert.equal(zone.classes.has('prompt-file-dragover'), true);
  const drop = drag('drop');
  zone.dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(dropped, 1);
  assert.equal(zone.classes.size, 0);
  unbind();
  zone.dispatchEvent(drag('drop'));
  assert.equal(dropped, 1);
});

test('non-file drags are untouched and disabled file drops are blocked without attaching', () => {
  const zone = new Zone();
  let dropped = 0;
  const unbind = bindFileDropZone(zone as unknown as HTMLElement, false, () => dropped++);
  const text = drag('drop', ['text/plain']);
  zone.dispatchEvent(text);
  assert.equal(text.defaultPrevented, false);
  const over = drag('dragover');
  zone.dispatchEvent(over);
  assert.equal(over.dataTransfer?.dropEffect, 'none');
  zone.dispatchEvent(drag('dragenter'));
  assert.equal(zone.classes.size, 0);
  const drop = drag('drop');
  zone.dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(dropped, 0);
  unbind();
});

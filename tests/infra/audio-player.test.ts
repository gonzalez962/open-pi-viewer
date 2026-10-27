import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSpeechPlaybackState,
  subscribeSpeechPlayback,
  pauseSpeechAudio,
  resumeSpeechAudio,
  toggleSpeechAudioPause,
  stopSpeechAudio,
  isSpeechAudioPlaying,
} from '../../src/infra/audio-player';

test('Audio Player Pause & Resume State Management', async (t) => {
  await t.test('initial state is idle and inactive', () => {
    stopSpeechAudio();
    const state = getSpeechPlaybackState();
    assert.equal(state.isActive, false);
    assert.equal(state.isPlaying, false);
    assert.equal(state.isPaused, false);
    assert.equal(state.currentTrackId, null);
    assert.equal(isSpeechAudioPlaying(), false);
  });

  await t.test('pause/resume on idle audio returns false without throwing', async () => {
    stopSpeechAudio();
    const paused = await pauseSpeechAudio();
    assert.equal(paused, false);

    const resumed = await resumeSpeechAudio();
    assert.equal(resumed, false);

    const toggled = await toggleSpeechAudioPause();
    assert.equal(toggled, 'idle');
  });

  await t.test('subscribeSpeechPlayback receives initial state and unsubscribe removes listener', () => {
    let callCount = 0;
    let lastReceived: any = null;

    const unsubscribe = subscribeSpeechPlayback((state) => {
      callCount++;
      lastReceived = state;
    });

    assert.equal(callCount, 1);
    assert.equal(lastReceived.isActive, false);

    stopSpeechAudio();
    assert.equal(callCount, 2);

    unsubscribe();
    stopSpeechAudio();
    // After unsubscribe, count shouldn't increase
    assert.equal(callCount, 2);
  });
});

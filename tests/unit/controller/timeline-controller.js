import TimelineController from '../../../src/controller/timeline-controller';
import Hls from '../../../src/hls';

describe('TimelineController', function () {
  let timelineController;
  let hls;

  beforeEach(function () {
    hls = new Hls();
    hls.config.enableWebVTT = true;
    hls.config.renderNatively = true;
    timelineController = new TimelineController(hls);
    timelineController.media = document.createElement('video');
  });

  it('should set default track to showing when displaySubtitles is true', function () {
    hls.subtitleTrackController = { subtitleDisplay: true };

    timelineController.onManifestLoaded({
      subtitles: [{ id: 0 }, { id: 1, default: true }]
    });

    expect(timelineController.textTracks[0].mode).to.equal('disabled');
    expect(timelineController.textTracks[1].mode).to.equal('showing');
  });

  it('should set default track to hidden when displaySubtitles is false', function () {
    hls.subtitleTrackController = { subtitleDisplay: false };

    timelineController.onManifestLoaded({
      subtitles: [{ id: 0 }, { id: 1, default: true }]
    });

    expect(timelineController.textTracks[0].mode).to.equal('disabled');
    expect(timelineController.textTracks[1].mode).to.equal('hidden');
  });

  describe('reuse text track', () => {
    it('should reuse text track when track order is same between manifests', () => {
      hls.subtitleTrackController = { subtitleDisplay: false };

      timelineController.onManifestLoaded({
        subtitles: [{ id: 0, name: 'en' }, { id: 1, name: 'ru' }]
      });

      // text tracks model contain only newly added manifest tracks, in same order as in manifest
      expect(timelineController.textTracks[0].label).to.equal('en');
      expect(timelineController.textTracks[1].label).to.equal('ru');
      expect(timelineController.textTracks.length).to.equal(2);
      // text tracks of the media contain the newly added text tracks
      expect(timelineController.media.textTracks[0].label).to.equal('en');
      expect(timelineController.media.textTracks[1].label).to.equal('ru');
      expect(timelineController.media.textTracks.length).to.equal(2);

      timelineController.onManifestLoaded({
        subtitles: [{ id: 0, name: 'en' }, { id: 1, name: 'ru' }]
      });

      // text tracks model contain only newly added manifest tracks, in same order
      expect(timelineController.textTracks[0].label).to.equal('en');
      expect(timelineController.textTracks[1].label).to.equal('ru');
      expect(timelineController.textTracks.length).to.equal(2);
      // text tracks of the media contain the previously added text tracks, in same order as the manifest order
      expect(timelineController.media.textTracks[0].label).to.equal('en');
      expect(timelineController.media.textTracks[1].label).to.equal('ru');
      expect(timelineController.media.textTracks.length).to.equal(2);
    });

    it('should reuse text track when track order is not same between manifests', () => {
      hls.subtitleTrackController = { subtitleDisplay: false };

      timelineController.onManifestLoaded({
        subtitles: [{ id: 0, name: 'en' }, { id: 1, name: 'ru' }]
      });

      // text tracks model contain only newly added manifest tracks, in same order as in manifest
      expect(timelineController.textTracks[0].label).to.equal('en');
      expect(timelineController.textTracks[1].label).to.equal('ru');
      expect(timelineController.textTracks.length).to.equal(2);
      // text tracks of the media contain the newly added text tracks
      expect(timelineController.media.textTracks[0].label).to.equal('en');
      expect(timelineController.media.textTracks[1].label).to.equal('ru');
      expect(timelineController.media.textTracks.length).to.equal(2);

      timelineController.onManifestLoaded({
        subtitles: [{ id: 0, name: 'ru' }, { id: 1, name: 'en' }]
      });

      // text tracks model contain only newly added manifest tracks, in same order
      expect(timelineController.textTracks[0].label).to.equal('ru');
      expect(timelineController.textTracks[1].label).to.equal('en');
      expect(timelineController.textTracks.length).to.equal(2);
      // text tracks of the media contain the previously added text tracks).to.equal(in opposite order to the manifest order
      expect(timelineController.media.textTracks[0].label).to.equal('en');
      expect(timelineController.media.textTracks[1].label).to.equal('ru');
      expect(timelineController.media.textTracks.length).to.equal(2);
    });
  });
});

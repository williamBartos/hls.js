/*
 * Timeline Controller
*/

import Event from '../events';
import EventHandler from '../event-handler';
import Cea608Parser from '../utils/cea-608-parser';
import OutputFilter from '../utils/output-filter';
import WebVTTParser from '../utils/webvtt-parser';
import { logger } from '../utils/logger';
import { sendAddTrackEvent, clearCurrentCues } from '../utils/texttrack-utils';

function canReuseVttTextTrack (inUseTrack, manifestTrack) {
  return inUseTrack && inUseTrack.label === manifestTrack.name && !(inUseTrack.textTrack1 || inUseTrack.textTrack2);
}

function intersection (x1, x2, y1, y2) {
  return Math.min(x2, y2) - Math.max(x1, y1);
}

class TimelineController extends EventHandler {
  constructor (hls) {
    super(hls, Event.MEDIA_ATTACHING,
      Event.MEDIA_DETACHING,
      Event.FRAG_PARSING_USERDATA,
      Event.FRAG_DECRYPTED,
      Event.MANIFEST_LOADING,
      Event.MANIFEST_LOADED,
      Event.FRAG_LOADED,
      Event.LEVEL_SWITCHING,
      Event.INIT_PTS_FOUND,
      Event.FRAG_PARSING_INIT_SEGMENT,
      Event.SUBTITLE_TRACKS_CLEARED
    );

    this.hls = hls;
    this.config = hls.config;
    this.enabled = true;
    this.Cues = hls.config.cueHandler;
    this.textTracks = [];
    this.tracks = [];
    this.unparsedVttFrags = [];
    this.initPTS = [];
    this.cueRanges = {};
    this.captionsTracks = {};

    this.captionsProperties = {
      textTrack1: {
        label: this.config.captionsTextTrack1Label,
        languageCode: this.config.captionsTextTrack1LanguageCode
      },
      textTrack2: {
        label: this.config.captionsTextTrack2Label,
        languageCode: this.config.captionsTextTrack2LanguageCode
      },
      textTrack3: {
        label: this.config.captionsTextTrack1Label,
        languageCode: this.config.captionsTextTrack1LanguageCode
      },
      textTrack4: {
        label: this.config.captionsTextTrack2Label,
        languageCode: this.config.captionsTextTrack2LanguageCode
      }
    };

    if (this.config.enableCEA708Captions) {
      const channel1 = new OutputFilter(this, 'textTrack1');
      const channel2 = new OutputFilter(this, 'textTrack2');
      const channel3 = new OutputFilter(this, 'textTrack3');
      const channel4 = new OutputFilter(this, 'textTrack4');
      this.cea608Parser = new Cea608Parser(channel1, channel2, channel3, channel4);
    }
  }

  addCues (trackName, startTime, endTime, screen) {
    // skip cues which overlap more than 50% with previously parsed time ranges
    let ranges = this.cueRanges[trackName];
    if (!ranges) {
      ranges = this.cueRanges[trackName] = [];
    }
    let merged = false;
    for (let i = ranges.length; i--;) {
      let cueRange = ranges[i];
      let overlap = intersection(cueRange[0], cueRange[1], startTime, endTime);
      if (overlap >= 0) {
        cueRange[0] = Math.min(cueRange[0], startTime);
        cueRange[1] = Math.max(cueRange[1], endTime);
        merged = true;
        if ((overlap / (endTime - startTime)) > 0.5) {
          return;
        }
      }
    }
    if (!merged) {
      ranges.push([startTime, endTime]);
    }

    let cues = this.Cues.createCues(startTime, endTime, screen);
    if (this.config.renderNatively) {
      cues.forEach((cue) => {
        this.captionsTracks[trackName].addCue(cue);
      });
    } else {
      this.hls.trigger(Event.CUES_PARSED, { type: 'captions', cues: cues, track: trackName });
    }
  }

  // Triggered when an initial PTS is found; used for synchronisation of WebVTT.
  onInitPtsFound (data) {
    if (data.id === 'main') {
      this.initPTS[data.frag.cc] = data.initPTS;
    }

    // Due to asynchronous processing, initial PTS may arrive later than the first VTT fragments are loaded.
    // Parse any unparsed fragments upon receiving the initial PTS.
    if (this.unparsedVttFrags.length) {
      const unparsedVttFrags = this.unparsedVttFrags;
      this.unparsedVttFrags = [];
      unparsedVttFrags.forEach(frag => {
        this.onFragLoaded(frag);
      });
    }
  }

  getExistingTrack (trackName) {
    const { media } = this;
    if (media) {
      for (let i = 0; i < media.textTracks.length; i++) {
        let textTrack = media.textTracks[i];
        if (textTrack[trackName]) {
          return textTrack;
        }
      }
    }
    return null;
  }

  createCaptionsTrack (trackName) {
    if (this.captionsTracks[trackName]) {
      return;
    }

    if (this.config.renderNatively) {
      this.createNativeTrack(trackName);
    } else {
      this.createNonNativeTrack(trackName);
    }
  }

  createNativeTrack (trackName) {
    const { label, languageCode } = this.captionsProperties[trackName];
    const captionsTracks = this.captionsTracks;
    if (!captionsTracks[trackName]) {
      // Enable reuse of existing text track.
      const existingTrack = this.getExistingTrack(trackName);
      if (!existingTrack) {
        const textTrack = this.createTextTrack('captions', label, languageCode);
        if (textTrack) {
          // Set a special property on the track so we know it's managed by Hls.js
          textTrack[trackName] = true;
          captionsTracks[trackName] = textTrack;
        }
      } else {
        captionsTracks[trackName] = existingTrack;
        clearCurrentCues(captionsTracks[trackName]);
        sendAddTrackEvent(captionsTracks[trackName], this.media);
      }
    }
  }

  createNonNativeTrack (trackName) {
    // Create a list of a single track for the provider to consume
    const { captionsTracks, captionsProperties } = this;
    const props = captionsProperties[trackName];
    if (!props) {
      return;
    }
    const label = props.label;
    const track = {
      '_id': trackName,
      label,
      kind: 'captions',
      'default': false
    };
    captionsTracks[trackName] = track;
    this.hls.trigger(Event.NON_NATIVE_TEXT_TRACKS_FOUND, { tracks: [track] });
  }

  createTextTrack (kind, label, lang) {
    const media = this.media;
    if (media) {
      return media.addTextTrack(kind, label, lang);
    }
  }

  destroy () {
    EventHandler.prototype.destroy.call(this);
  }

  onMediaAttaching (data) {
    this.media = data.media;
    this._cleanTracks();
  }

  onMediaDetaching () {
    const { captionsTracks } = this;
    Object.keys(captionsTracks).forEach(trackName => {
      clearCurrentCues(captionsTracks[trackName]);
      delete captionsTracks[trackName];
    });
  }

  onManifestLoading () {
    this.lastSn = -1; // Detect discontiguity in fragment parsing
    this.prevCC = -1;
    // Detect discontinuity in subtitle manifests
    // The start time for cc 0 is always 0; initialize it here first so that we don't accidentally set to the currentTime
    // when captions are enabled.
    this.vttCCs = {
      ccOffset: 0,
      presentationOffset: 0,
      0: {
        start: 0, prevCC: -1, new: false
      }
    };
    this._cleanTracks();
  }

  _cleanTracks () {
    // clear outdated subtitles
    const media = this.media;
    if (!media || !media.textTracks) {
      return;
    }

    const textTracks = media.textTracks;
    for (let i = 0; i < textTracks.length; i++) {
      // do not clear tracks that are managed externally
      if (textTracks[i].textTrack1 || textTracks[i].textTrack2) {
        clearCurrentCues(textTracks[i]);
      }
    }
  }

  onManifestLoaded (data) {
    this.textTracks = [];
    this.unparsedVttFrags = this.unparsedVttFrags || [];
    this.initPTS = [];
    this.cueRanges = {};

    if (this.config.enableWebVTT) {
      const sameTracks = this.tracks && data.subtitles && this.tracks.length === data.subtitles.length;
      this.tracks = data.subtitles || [];

      if (this.config.renderNatively) {
        let inUseTracks = this.media ? this.media.textTracks : [];

        this.tracks.forEach((track, index) => {
          let textTrack;
          if (index < inUseTracks.length) {
            let inUseTrack = null;

            for (let i = 0; i < inUseTracks.length; i++) {
              if (canReuseVttTextTrack(inUseTracks[i], track)) {
                inUseTrack = inUseTracks[i];
                break;
              }
            }
            // Reuse tracks with the same label, but do not reuse 608/708 tracks
            if (inUseTrack) {
              textTrack = inUseTrack;
            }
          }
          if (!textTrack) {
            textTrack = this.createTextTrack('subtitles', track.name, track.lang);
          }

          if (track.default) {
            textTrack.mode = this.hls.subtitleDisplay ? 'showing' : 'hidden';
          } else {
            textTrack.mode = 'disabled';
          } this.textTracks.push(textTrack);
        });
      } else if (!sameTracks && this.tracks && this.tracks.length) {
        // Create a list of tracks for the provider to consume
        let tracksList = this.tracks.map((track) => {
          return {
            'label': track.name,
            'kind': track.type.toLowerCase(),
            'default': track.default
          };
        });
        this.hls.trigger(Event.NON_NATIVE_TEXT_TRACKS_FOUND, { tracks: tracksList });
      }
    }

    if (this.config.enableCEA708Captions && data.captions) {
      data.captions.forEach(captionsTrack => {
        const instreamIdMatch = /(?:CC|SERVICE)([1-4])/.exec(captionsTrack.instreamId);

        if (!instreamIdMatch) {
          return;
        }

        let trackName = `textTrack${instreamIdMatch[1]}`;
        this.captionsProperties[trackName].label = captionsTrack.name;

        if (captionsTrack.lang) { // optional attribute
          this.captionsProperties[trackName].languageCode = captionsTrack.lang;
        }
      });
    }
  }

  onLevelSwitching () {
    this.enabled = this.hls.currentLevel.closedCaptions !== 'NONE';
  }

  onFragLoaded (data) {
    const frag = data.frag;
    if (frag.type === 'main') {
      let sn = frag.sn;
      // if this frag isn't contiguous, clear the parser so cues with bad start/end times aren't added to the textTrack
      if (sn !== this.lastSn + 1) {
        const cea608Parser = this.cea608Parser;
        if (cea608Parser) {
          cea608Parser.reset();
        }
      }
      this.lastSn = sn;
    } // eslint-disable-line brace-style
    // If fragment is subtitle type, parse as WebVTT.
    else if (frag.type === 'subtitle') {
      const payload = data.payload;
      if (payload.byteLength) {
        // We need an initial synchronisation PTS. Store fragments as long as none has arrived.
        if (!Number.isFinite(this.initPTS[frag.cc])) {
          this.unparsedVttFrags.push(data);
          if (this.initPTS.length) {
            // finish unsuccessfully, otherwise the subtitle-stream-controller could be blocked from loading new frags.
            this.hls.trigger(Event.SUBTITLE_FRAG_PROCESSED, { success: false, frag: frag });
          }
          return;
        }

        let decryptData = frag.decryptdata;
        // If the subtitles are not encrypted, parse VTTs now. Otherwise, we need to wait.
        if ((decryptData == null) || (decryptData.key == null) || (decryptData.method !== 'AES-128')) {
          this._parseVTTs(frag, payload);
        }
      } else {
        // In case there is no payload, finish unsuccessfully.
        this.hls.trigger(Event.SUBTITLE_FRAG_PROCESSED, { success: false, frag: frag });
      }
    }
  }

  _parseVTTs (frag, payload) {
    let vttCCs = this.vttCCs;
    if (!vttCCs[frag.cc]) {
      vttCCs[frag.cc] = { start: frag.start, prevCC: this.prevCC, new: true };
      this.prevCC = frag.cc;
    }
    const tracks = (this.config.renderNatively) ? this.textTracks : this.tracks;
    const hls = this.hls;

    // Parse the WebVTT file contents.
    WebVTTParser.parse(payload, this.initPTS[frag.cc], vttCCs, frag.cc, (cues) => {
      const currentTrack = tracks[frag.level];

      if (this.config.renderNatively) {
        cues.filter(cue => !currentTrack.cues.getCueById(cue.id))
          .forEach(cue => {
            currentTrack.addCue(cue);
          });
      } else {
        let trackId = currentTrack.default ? 'default' : 'subtitles' + frag.level;
        hls.trigger(Event.CUES_PARSED, { type: 'subtitles', cues: cues, track: trackId });
      }
      hls.trigger(Event.SUBTITLE_FRAG_PROCESSED, { success: true, frag: frag });
    },
    function (e) {
      // Something went wrong while parsing. Trigger event with success false.
      logger.log(`Failed to parse VTT cue: ${e}`);
      hls.trigger(Event.SUBTITLE_FRAG_PROCESSED, { success: false, frag: frag });
    });
  }

  onFragDecrypted (data) {
    const decryptedData = data.payload,
      frag = data.frag;

    if (frag.type === 'subtitle') {
      if (!Number.isFinite(this.initPTS[frag.cc])) {
        this.unparsedVttFrags.push(data);
        return;
      }

      this._parseVTTs(frag, decryptedData);
    }
  }

  onSubtitleTracksCleared () {
    this.tracks = [];
    this.captionsTracks = {};
  }

  onFragParsingUserdata (data) {
    // push all of the CEA-708 messages into the interpreter
    // immediately. It will create the proper timestamps based on our PTS value
    if (this.enabled && this.config.enableCEA708Captions) {
      for (let i = 0; i < data.samples.length; i++) {
        let ccdatas = this.extractCea608Data(data.samples[i].bytes);
        this.cea608Parser.addData(data.samples[i].pts, ccdatas[0], 1);
        this.cea608Parser.addData(data.samples[i].pts, ccdatas[1], 3);
      }
    }
  }

  onFragParsingInitSegment () {
    // If we receive this event, we have not received an onInitPtsFound event. This happens when the video track has no samples (but has audio)
    // In order to have captions display, which requires an initPTS, we assume one of 90000
    if (typeof this.initPTS === 'undefined') {
      this.onInitPtsFound({ initPTS: 90000 });
    }
  }

  extractCea608Data (byteArray) {
    let count = byteArray[0] & 31;
    let position = 2;
    let tmpByte, ccbyte1, ccbyte2, ccValid, ccType;
    let actualCCBytes = [[], []];

    for (let j = 0; j < count; j++) {
      tmpByte = byteArray[position++];
      ccbyte1 = 0x7F & byteArray[position++];
      ccbyte2 = 0x7F & byteArray[position++];
      ccValid = (4 & tmpByte) !== 0;
      ccType = 3 & tmpByte;

      if (ccbyte1 === 0 && ccbyte2 === 0) {
        continue;
      }

      if (ccValid) {
        if (ccType === 0 || ccType === 1) {
          actualCCBytes[ccType].push(ccbyte1);
          actualCCBytes[ccType].push(ccbyte2);
        }
      }
    }
    return actualCCBytes;
  }
}

export default TimelineController;

/*
 * Level Controller
*/

import Event from '../events';
import EventHandler from '../event-handler';
import {logger} from '../utils/logger';
import {ErrorTypes, ErrorDetails} from '../errors';
import BufferHelper from '../helper/buffer-helper';
import {isCodecSupportedInMp4} from '../utils/codecs';

class LevelController extends EventHandler {

  constructor(hls) {
    super(hls,
      Event.MANIFEST_LOADED,
      Event.LEVEL_LOADED,
      Event.FRAG_LOADED,
      Event.ERROR,
      Event.LEVEL_REMOVED);
    this._manualLevel = -1;
    this.timer = null;
  }

  destroy() {
    this.cleanTimer();
    this._manualLevel = -1;
  }

  cleanTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  startLoad() {
    this.canload = true;
    let levels = this._levels;
    // clean up live level details to force reload them, and reset load errors
    if(levels) {
      levels.forEach(level => {
        level.loadError = 0;
        const levelDetails = level.details;
        if (levelDetails && levelDetails.live) {
          level.details = undefined;
        }
      });
    }
    // speed up live playlist refresh if timer exists
    if (this.timer) {
      this.tick();
    }
  }

  stopLoad() {
    this.canload = false;
  }

  onManifestLoaded(data) {
    let levels = [];
    let bitrateStart;
    let levelSet = {};
    let levelFromSet = null;
    let videoCodecFound = false;
    let audioCodecFound = false;
    let chromeOrFirefox = /chrome|firefox/.test(navigator.userAgent.toLowerCase());
    let audioTracks = [];

    // regroup redundant levels together
    data.levels.forEach(level => {
      level.loadError = 0;
      level.fragmentError = false;

      videoCodecFound = videoCodecFound || !!level.videoCodec;
      audioCodecFound = audioCodecFound || !!level.audioCodec || !!(level.attrs && level.attrs.AUDIO);

      // erase audio codec info if browser does not support mp4a.40.34.
      // demuxer will autodetect codec and fallback to mpeg/audio
      if (chromeOrFirefox === true && level.audioCodec && level.audioCodec.indexOf('mp4a.40.34') !== -1) {
        level.audioCodec = undefined;
      }

      levelFromSet = levelSet[level.bitrate];

      if (levelFromSet === undefined) {
        level.url = [level.url];
        level.urlId = 0;
        levelSet[level.bitrate] =level;
          levels.push(level);
        }
       else {
      levelFromSet.url.push( level .url);
    }
    });

    // remove audio-only level if we also have levels with audio+video codecs signalled
    if (videoCodecFound === true && audioCodecFound === true) {
      levels = levels.filter(({videoCodec}) => !!videoCodec);
    }

    // only keep levels with supported audio/video codecs
    levels = levels.filter(({audioCodec, videoCodec}) => {
      return (!audioCodec || isCodecSupportedInMp4(audioCodec)) && (!videoCodec || isCodecSupportedInMp4(videoCodec));
    });

    if (data.audioTracks) {
      audioTracks = data.audioTracks.filter(track => !track.audioCodec || isCodecSupportedInMp4(track.audioCodec, 'audio'));
    }

    if(levels.length) {
      // start bitrate is the first bitrate of the manifest
      bitrateStart = levels[0].bitrate;
      // sort level on bitrate
      levels.sort(function (a, b) {
        return a.bitrate - b.bitrate;
      });
      this._levels = levels;
      // find index of first level in sorted levels
      for (let i = 0; i < levels.length; i++) {
        if (levels[i].bitrate === bitrateStart) {
          this._firstLevel = i;
          logger.log(`manifest loaded,${levels.length} level(s) found, first bitrate:${bitrateStart}`);
          break;
        }
      }
      this.hls.trigger(Event.MANIFEST_PARSED, {levels, audioTracks, firstLevel: this._firstLevel, stats: data.stats, audio : audioCodecFound, video : videoCodecFound, altAudio : audioTracks.length > 0});
    } else {
      this.hls.trigger(Event.ERROR, {
        type   : ErrorTypes.MEDIA_ERROR,
        details: ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR,
        fatal  : true,
        url    : this.hls.url,
        reason : 'no level with compatible codecs found in manifest'
      });
    }
  }

  get levels() {
    return this._levels;
  }

  get level() {
    return this._level;
  }

  set level(newLevel) {
    let levels = this._levels;
    if (levels && levels.length > newLevel) {
      if (this._level !== newLevel || levels[newLevel].details === undefined) {
        this.setLevelInternal(newLevel);
      }
    }
  }

 setLevelInternal(newLevel) {
    const levels = this._levels;
    const hls = this.hls;
    // check if level idx is valid
    if (newLevel >= 0 && newLevel < levels.length) {
      // stopping live reloading timer if any
      this.cleanTimer();
      if (this._level !== newLevel) {
        logger.log(`switching to level ${newLevel}`);
        this._level = newLevel;
        var levelProperties = levels[newLevel];
        levelProperties.level = newLevel;
        // LEVEL_SWITCH to be deprecated in next major release
        hls.trigger(Event.LEVEL_SWITCH, levelProperties);
        hls.trigger(Event.LEVEL_SWITCHING, levelProperties);
      }
      var level = levels[newLevel], levelDetails = level.details;
       // check if we need to load playlist for this level
      if (!levelDetails || levelDetails.live === true) {
        // level not retrieved yet, or live playlist we need to (re)load it
        var urlId = level.urlId;
        hls.trigger(Event.LEVEL_LOADING, {url: level.url[urlId], level: newLevel, id: urlId});
      }
    } else {
      // invalid level id given, trigger error
      hls.trigger(Event.ERROR, {type : ErrorTypes.OTHER_ERROR, details: ErrorDetails.LEVEL_SWITCH_ERROR, level: newLevel, fatal: false, reason: 'invalid level idx'});
    }
 }

  get manualLevel() {
    return this._manualLevel;
  }

  set manualLevel(newLevel) {
    this._manualLevel = newLevel;
    if (this._startLevel === undefined) {
      this._startLevel = newLevel;
    }
    if (newLevel !== -1) {
      this.level = newLevel;
    }
  }

  get firstLevel() {
    return this._firstLevel;
  }

  set firstLevel(newLevel) {
    this._firstLevel = newLevel;
  }

  get startLevel() {
    // hls.startLevel takes precedence over config.startLevel
    // if none of these values are defined, fallback on this._firstLevel (first quality level appearing in variant manifest)
    if (this._startLevel === undefined) {
      let configStartLevel = this.hls.config.startLevel;
      if (configStartLevel !== undefined) {
        return configStartLevel;
      } else {
        return this._firstLevel;
      }
    } else {
      return this._startLevel;
    }
  }

  set startLevel(newLevel) {
    this._startLevel = newLevel;
  }

  onError(data) {
    if (data.fatal === true) {
      if (data.type === ErrorTypes.NETWORK_ERROR) {
        this.cleanTimer();
      }
      return;
    }

    let details = data.details, levelError = false, fragmentError = false;
    let levelIndex, level;
    let {config, media} = this.hls;

    // try to recover not fatal errors
    switch (details) {
      case ErrorDetails.FRAG_LOAD_ERROR:
      case ErrorDetails.FRAG_LOAD_TIMEOUT:
      case ErrorDetails.FRAG_LOOP_LOADING_ERROR:
      case ErrorDetails.KEY_LOAD_ERROR:
      case ErrorDetails.KEY_LOAD_TIMEOUT:
        levelIndex = data.frag.level;
        fragmentError = true;
        break;
      case ErrorDetails.LEVEL_LOAD_ERROR:
      case ErrorDetails.LEVEL_LOAD_TIMEOUT:
        levelIndex = data.context.level;
        levelError = true;
        break;
      case ErrorDetails.REMUX_ALLOC_ERROR:
        levelIndex = data.level;
        break;
    }
    /* try to switch to a redundant stream if any available.
     * if no redundant stream available, emergency switch down (if in auto mode and current level not 0)
     * otherwise, we cannot recover this network error ...
     */
    if (levelIndex !== undefined) {
      level = this._levels[levelIndex];
      level.loadError++;
      level.fragmentError = fragmentError;

      // if any redundant streams available and if we haven't try them all (level.loadError is reseted on successful frag/level load.
      // if level.loadError reaches redundantLevels it means that we tried them all, no hope  => let's switch down
      const redundantLevels = level.url.length;

      if (redundantLevels > 1 && level.loadError < redundantLevels) {
        level.urlId = (level.urlId + 1) % redundantLevels;
        level.details = undefined;
        logger.warn(`level controller,${details} for level ${levelIndex}: switching to redundant stream id ${level.urlId}`);
      } else {
        // we could try to recover if in auto mode and current level not lowest level (0)
        if ((this._manualLevel === -1) && levelIndex !== 0) {
          logger.warn(`level controller,${details}: switch-down for next fragment`);
          this.hls.nextAutoLevel = Math.max(0, levelIndex - 1);
        } else if (level && level.details && level.details.live) {
          logger.warn(`level controller,${details} on live stream, discard`);
          if (levelError === true) {
            // reset this._level so that another call to set level() will trigger again a frag load
            this._level = undefined;
          }
          // other errors are handled by stream controller
        } else if (levelError === true) {
          // 0.5 : tolerance needed as some browsers stalls playback before reaching buffered end
          let mediaBuffered = !!media && BufferHelper.isBuffered(media, media.currentTime) && BufferHelper.isBuffered(media, media.currentTime + 0.5);
          // FIXME Rely on Level Retry parameters, now it's possible to retry as long as media is buffered
          if (mediaBuffered === true) {
            logger.warn(`level controller,${details}, but media buffered, retry in ${config.levelLoadingRetryDelay}ms`);
            this.timer = setTimeout(() => this.tick(), config.levelLoadingRetryDelay);
            // boolean used to inform stream controller not to switch back to IDLE on non fatal error
            data.levelRetry = true;
          } else {
            logger.error(`cannot recover ${details} error`);
            this._level = undefined;
            // stopping live reloading timer if any
            this.cleanTimer();
            // switch error to fatal
            data.fatal = true;
          }
        }
      }
    }
  }

  // reset errors on the successful load of a fragment
  onFragLoaded({frag}) {
    if (frag !== undefined && frag.type === 'main') {
      const level = this._levels[frag.level];
      if (level !== undefined) {
        level.fragmentError = false;
        level.loadError = 0;
      }
    }
  }

  onLevelLoaded(data) {
    const levelId = data.level;
    // only process level loaded events matching with expected level
    if (levelId === this._level) {
      let curLevel = this._levels[levelId];
      // reset level load error counter on successful level loaded only if there is no issues with fragments
      if(curLevel.fragmentError === false){
        curLevel.loadError = 0;
      }
      let newDetails = data.details;
      // if current playlist is a live playlist, arm a timer to reload it
      if (newDetails.live) {
        let reloadInterval = 1000 * ( newDetails.averagetargetduration ? newDetails.averagetargetduration : newDetails.targetduration),
            curDetails     = curLevel.details;
        if (curDetails && newDetails.endSN === curDetails.endSN) {
          // follow HLS Spec, If the client reloads a Playlist file and finds that it has not
          // changed then it MUST wait for a period of one-half the target
          // duration before retrying.
          reloadInterval /= 2;
          logger.log(`same live playlist, reload twice faster`);
        }
        // decrement reloadInterval with level loading delay
        reloadInterval -= performance.now() - data.stats.trequest;
        // in any case, don't reload more than every second
        reloadInterval = Math.max(1000, Math.round(reloadInterval));
        logger.log(`live playlist, reload in ${reloadInterval} ms`);
        this.timer = setTimeout(() => this.tick(), reloadInterval);
      } else {
        this.cleanTimer();
      }
    }
  }

  tick() {
    var levelId = this._level;
    if (levelId !== undefined && this.canload) {
      var level = this._levels[levelId];
      if (level && level.url) {
        var urlId = level.urlId;
        this.hls.trigger(Event.LEVEL_LOADING, {url: level.url[urlId], level: levelId, id: urlId});
      }
    }
  }

  get nextLoadLevel() {
    if (this._manualLevel !== -1) {
      return this._manualLevel;
    } else {
     return this.hls.nextAutoLevel;
    }
  }

  set nextLoadLevel(nextLevel) {
    this.level = nextLevel;
    if (this._manualLevel === -1) {
      this.hls.nextAutoLevel = nextLevel;
    }
  }

  onLevelRemoved(data) {
    this._levels = this.levels.filter((level, index) => index !== data.level);
  }
}

export default LevelController;

import { InitSegmentData, RemuxedTrack, Remuxer, RemuxerResult } from '../types/remuxer';
import { getDuration, getStartDTS, offsetStartDTS, parseInitSegment } from '../utils/mp4-tools';
import { TrackSet } from '../types/track';

class PassThroughRemuxer implements Remuxer {
  private emitInitSegment: boolean = false;
  private audioCodec?: string;
  private videoCodec?: string;
  private initData?: any;
  private initPTS?: number;
  private initTracks?: TrackSet;
  private lastEndDTS?: number;

  destroy () {
  }

  resetTimeStamp (defaultInitPTS) {
    this.initPTS = defaultInitPTS;
    this.lastEndDTS = undefined;
  }

  resetInitSegment (initSegment, audioCodec, videoCodec) {
    this.audioCodec = audioCodec;
    this.videoCodec = videoCodec;
    this.generateInitSegment(initSegment);
    this.emitInitSegment = true;
  }

  generateInitSegment (initSegment): void {
    let { audioCodec, videoCodec } = this;
    if (!initSegment || !initSegment.byteLength) {
      this.initTracks = undefined;
      this.initData = undefined;
      return;
    }
    const initData = this.initData = parseInitSegment(initSegment) as any;

    // default audio codec if nothing specified
    // TODO : extract that from initsegment
    if (!audioCodec) {
      audioCodec = 'mp4a.40.5';
    }

    if (!videoCodec) {
      videoCodec = 'avc1.42e01e';
    }

    const tracks = {} as TrackSet;
    if (initData.audio && initData.video) {
      tracks.audiovideo = {
        container: 'video/mp4',
        codec: audioCodec + ',' + videoCodec,
        initSegment
      };
    } else {
      if (initData.audio) {
        tracks.audio = { container: 'audio/mp4', codec: audioCodec, initSegment };
      }

      if (initData.video) {
        tracks.video = { container: 'video/mp4', codec: videoCodec, initSegment };
      }
    }
    this.initTracks = tracks;
  }

  // TODO: Handle unsignaled discontinuities; contiguous and accurateTimeOffset flags are currently unused
  remux (audioTrack, videoTrack, id3Track, textTrack, timeOffset, contiguous, accurateTimeOffset): RemuxerResult {
    let { initPTS, lastEndDTS } = this;

    // If we haven't yet set a lastEndDTS, or it was reset, set it to the provided timeOffset. We want to use the
    // lastEndDTS over timeOffset whenever possible; during progressive playback, the media source will not update
    // the media duration (which is what timeOffset is provided as) before we need to process the next chunk.
    if (!Number.isFinite(lastEndDTS)) {
      lastEndDTS = this.lastEndDTS = timeOffset || 0;
    }

    // The binary segment data is added to the videoTrack in the mp4demuxer. We don't check to see if the data is only
    // audio or video (or both); adding it to video was an arbitrary choice.
    const data = videoTrack.samples;
    if (!data || !data.length) {
      return {
          audio: undefined,
          video: undefined,
          text: textTrack,
          id3: id3Track,
          initSegment: undefined
      };
    }

    const initSegment: InitSegmentData = {};
    let initData = this.initData;
    if (!initData) {
        this.generateInitSegment(data);
        initData = this.initData;
    }
    if (this.emitInitSegment) {
        initSegment.tracks = this.initTracks;
        this.emitInitSegment = false;
    }

    if (!Number.isFinite(initPTS as number)) {
        this.initPTS = initSegment.initPTS = initPTS = computeInitPTS(initData, data, timeOffset);
    }

    const duration = getDuration(data, initData);
    const startDTS = lastEndDTS as number;
    const endDTS = duration + startDTS;
    offsetStartDTS(initData, data, initPTS);
    this.lastEndDTS = endDTS;

    const track: RemuxedTrack = {
        data1: data,
        startPTS: startDTS,
        startDTS,
        endPTS: endDTS,
        endDTS,
        type: '',
        hasAudio: !!audioTrack.data,
        hasVideo: !!videoTrack.data,
        nb: 1,
        dropped: 0
    };

    if (initData.audio) {
        track.type += 'audio';
    }

    if (initData.video) {
        track.type += 'video';
    }

    return {
      audio: track.type === 'audio' ? track : undefined,
      video: track.type !== 'audio' ? track : undefined,
      text: textTrack,
      id3: id3Track,
      initSegment
    };
  }
}

const computeInitPTS = (initData, data, timeOffset) => getStartDTS(initData, data) - timeOffset;

export default PassThroughRemuxer;

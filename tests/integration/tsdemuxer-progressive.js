import TSDemuxer from '../../src/demux/tsdemuxer';
import MP4Remuxer from '../../src/remux/mp4-remuxer';
import { Observer } from '../../src/observer';
import { prependUint8Array } from '../../src/utils/mp4-tools';
import { diff } from 'deep-diff';

const mediaBuffer = require('arraybuffer-loader!../assets/bbb-480p-chunk.media');
const data = new Uint8Array(mediaBuffer);

describe('Progressive TSDemuxer integration tests', function () {
  let demuxer;
  let remuxer;
  let observer;
  beforeEach(function () {
    resetTransmuxer();
  });

  function resetTransmuxer () {
    observer = new Observer();
    demuxer = new TSDemuxer(observer, {}, {});
    remuxer = new MP4Remuxer(observer, {}, {}, '');
    demuxer.resetInitSegment();
    demuxer.resetTimeStamp();
  }

  it('produces equivalent output if transmuxed whole or chunked', function () {
    demuxer.demux(data, 0, true, false);
    const demuxResultWhole = demuxer.flush();
    const wholeAudioSamples = demuxResultWhole.audioTrack.samples.slice(0);
    const wholeAvcSamples = demuxResultWhole.avcTrack.samples.slice(0);
    const remuxResultWhole = remuxer.remux(demuxResultWhole, 0, false, true);
    // Re-assign samples removed during remuxing
    demuxResultWhole.audioTrack.samples = wholeAudioSamples;
    demuxResultWhole.avcTrack.samples = wholeAvcSamples;

    resetTransmuxer();
    const chunks = chunkSegmentData(data, 15);
    // expect(prependUint8Array(chunks[1], chunks[0])).to.deep.equal(data);

    let chunkedAudioSamples = [];
    let chunkedAvcSamples = [];
    let remuxedChunks = [];
    let demuxResultChunked;

    for (let i = 0; i < chunks.length + 1; i++) {
      let demuxedChunk;
      if (i === chunks.length) {
        demuxedChunk = demuxer.flush();
        // Tracks are shared objects throughout a demuxing session
        demuxResultChunked = demuxedChunk;
      } else {
        demuxedChunk = demuxer.demux(chunks[i]);
      }
      // Deep copy samples for later inspection - they're manipulated and deleted during remuxing
      chunkedAudioSamples.push(demuxedChunk.audioTrack.samples.slice(0));
      chunkedAvcSamples.push(demuxedChunk.avcTrack.samples.slice(0));
      const remuxedChunk = remuxer.remux(demuxedChunk, 0, i > 0, true);
      remuxedChunks.push(remuxedChunk);
    }

    demuxResultChunked.audioTrack.samples = chunkedAudioSamples;
    demuxResultChunked.avcTrack.samples = chunkedAvcSamples;

    verifyDemuxedTrack(demuxResultChunked.audioTrack, demuxResultWhole.audioTrack);
    verifyDemuxedTrack(demuxResultChunked.avcTrack, demuxResultWhole.avcTrack);

    const remuxedAudioTracks = remuxedChunks.map(t => t.audio).filter(t => !!t);
    const remuxedVideoTracks = remuxedChunks.map(t => t.video).filter(t => !!t);

    // verifyRemuxedChunks(remuxedAudioTracks);
    // verifyRemuxedChunks(remuxedVideoTracks);

    const mergedAudioTrack = mergeRemuxedChunks(remuxedAudioTracks);
    const mergedVideoTrack = mergeRemuxedChunks(remuxedVideoTracks);

    verifyRemuxedTrack(mergedAudioTrack, remuxResultWhole.audio);
    verifyRemuxedTrack(mergedVideoTrack, remuxResultWhole.video);
  });
});

function verifyDemuxedTrack (chunkedTrack, wholeTrack) {
  const type = chunkedTrack.type;
  expect(chunkedTrack.duration, `Chunked ${type} track duration should equal the duration of the non-chunked track`).to.equal(wholeTrack.duration);
  expect(chunkedTrack.dropped, `Total number of dropped ${type} samples should equal the number of non-chunked dropped samples`).to.equal(wholeTrack.dropped);
  verifyDemuxedSamples(chunkedTrack.samples, wholeTrack.samples, type);
}

function verifyDemuxedSamples (chunkedSamples, wholeSamples, type) {
  const message = (prop, i) => `${prop} property of chunked ${type} sample at position ${i} should equal the whole sample at the same array position`;
  const mergedSamples = [].concat.apply([], chunkedSamples);
  for (let i = 0; i < mergedSamples.length; i++) {
    const cSample = mergedSamples[i];
    const wSample = wholeSamples[i];
    if (!cSample || !wSample) {
      break;
    }
    expect(cSample.pts, message('pts', i)).to.deep.equal(wSample.pts);
    expect(cSample.dts, message('dts', i)).to.deep.equal(wSample.dts);
    expect(cSample.frame, message('frame', i)).to.deep.equal(wSample.frame);
    expect(cSample.key, message('key', i)).to.deep.equal(wSample.key);
    expect(cSample.length, message('length', i)).to.deep.equal(wSample.length);
    expect(cSample.units, message('units', i)).to.deep.equal(wSample.units);
    expect(cSample.debug, message('debug', i)).to.deep.equal(wSample.debug);
  }

  expect(mergedSamples.length, `Total number of chunked ${type} samples should equal the number of non-chunked samples`).to.equal(wholeSamples.length);
}

function verifyRemuxedChunks (trackChunks) {
  if (trackChunks.length < 2) {
    return;
  }

  const type = trackChunks[0].type;
  for (let i = 1; i < trackChunks.length; i++) {
    const prev = trackChunks[i - 1];
    const cur = trackChunks[i];
    // expect(cur.startPTS - prev.endPTS, `${type} track startPTS should be contiguous with the previous endPTS`).to.equal(0);
    expect(cur.startDTS - prev.endDTS, `${type} track startDTS should be contiguous with the previous endDTS`).to.equal(0);
  }
}

function verifyRemuxedTrack (chunkedTrack, wholeTrack) {
  const type = chunkedTrack.type;
  expect(chunkedTrack.startPTS, `Chunked ${type} track startPTS should equal the non-chunked startPTS`).to.equal(wholeTrack.startPTS);
  expect(chunkedTrack.endPTS, `Chunked ${type} track endPTS should equal the non-chunked endPTS`).to.equal(wholeTrack.endPTS);
  expect(chunkedTrack.startDTS, `Chunked ${type} track startDTS should equal the non-chunked startDTS`).to.equal(wholeTrack.startDTS);
  expect(chunkedTrack.endDTS, `Chunked ${type} track endDTS should equal the non-chunked endDTS`).to.equal(wholeTrack.endDTS);
}

function chunkSegmentData (data, numChunks = 1) {
  const result = [];
  let offset = 0;
  const chunkLen = Math.ceil(data.length / numChunks);
  for (let i = 1; i <= numChunks; i++) {
    const end = Math.min(chunkLen * i, data.length);
    const chunk = new Uint8Array(end - offset);
    chunk.set(data.slice(offset, end));
    result.push(chunk);
    offset = end;
  }
  return result;
}

function mergeRemuxedChunks (trackChunks) {
  return trackChunks.reduce((a, c) => {
    a.endPTS = c.endPTS;
    a.endDTS = c.endDTS;
    a.nb += c.nb;
    a.dropped += c.dropped;
    if (c.hasAudio) {
      a.hasAudio = true;
    }
    if (c.hasVideo) {
      a.hasVideo = true;
    }
    return a;
  }, trackChunks[0]);
}
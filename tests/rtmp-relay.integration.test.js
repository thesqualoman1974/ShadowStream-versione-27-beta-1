'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const { RtmpRelay } = require('../electron/streaming/rtmp-relay');

const ffmpegPath = process.env.SHADOWSTREAM_TEST_FFMPEG || 'D:\\ffmpeg\\bin\\ffmpeg.exe';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function runFfmpeg(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`FFmpeg integration process timed out: ${stderr}`));
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

test('FFmpeg relays one encoded local input to multiple RTMP destinations', {
  skip: !fs.existsSync(ffmpegPath) && 'Set SHADOWSTREAM_TEST_FFMPEG to run the local RTMP integration test.',
  timeout: 30000,
}, async () => {
  const receiverPorts = await Promise.all([reservePort(), reservePort()]);
  const receivers = [];
  const relay = new RtmpRelay({ ffmpegPath, log: () => {} });
  try {
    for (const receiverPort of receiverPorts) {
      const receiver = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-rtmp_listen', '1',
        '-i', `rtmp://127.0.0.1:${receiverPort}/live/receiver-key`,
        '-f', 'null', '-',
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      receiver.stderr.setEncoding('utf8');
      receiver.errorText = '';
      receiver.stderr.on('data', (chunk) => { receiver.errorText = (receiver.errorText + chunk).slice(-4096); });
      receivers.push(receiver);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 300);
        receiver.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        receiver.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`RTMP receiver failed to start (exit ${code}): ${receiver.errorText}`));
        });
      });
    }

    const input = await relay.start(receiverPorts.map((receiverPort, index) => ({
      name: `Local test receiver ${index + 1}`,
      server: `rtmp://127.0.0.1:${receiverPort}/live`,
      key: 'receiver-key',
    })));
    const sender = await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',
      '-t', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-f', 'flv', `${input.server}/${input.key}`,
    ]);
    assert.equal(sender.code, 0, sender.stderr);
    const receiverResults = await Promise.all(receivers.map((receiver) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        receiver.kill();
        reject(new Error('RTMP destination did not finish receiving the relayed stream.'));
      }, 10000);
      receiver.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      receiver.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    })));
    assert.deepEqual(receiverResults, [0, 0], receivers.map(({ errorText }) => errorText).join('\n'));
  } finally {
    await relay.stop();
    for (const receiver of receivers) {
      if (receiver.exitCode === null) receiver.kill();
    }
  }
});

test('FFmpeg creates a 1080x1920 NVENC TikTok output from the landscape input', {
  skip: !fs.existsSync(ffmpegPath) && 'Set SHADOWSTREAM_TEST_FFMPEG to run the local RTMP integration test.',
  timeout: 30000,
}, async (t) => {
  const nvenc = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.1',
    '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-',
  ]).catch((error) => ({ code: 1, stderr: error.message }));
  if (nvenc.code !== 0) {
    t.skip('A working NVIDIA h264_nvenc encoder is not available.');
    return;
  }

  const receiverPort = await reservePort();
  const receiverUrl = `rtmp://127.0.0.1:${receiverPort}/live/vertical-key`;
  const receiver = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'info',
    '-rtmp_listen', '1',
    '-i', receiverUrl,
    '-vf', 'showinfo',
    '-f', 'null', '-',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let receiverInfo = '';
  receiver.stderr.setEncoding('utf8');
  receiver.stderr.on('data', (chunk) => { receiverInfo = (receiverInfo + chunk).slice(-8192); });
  const relay = new RtmpRelay({ ffmpegPath, log: () => {} });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 300);
      receiver.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      receiver.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Vertical RTMP receiver failed to start (exit ${code}): ${receiverInfo}`));
      });
    });

    const input = await relay.start([{
      platform: 'tiktok',
      name: 'TikTok',
      server: `rtmp://127.0.0.1:${receiverPort}/live`,
      key: 'vertical-key',
    }]);
    const sender = await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',
      '-t', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-f', 'flv', `${input.server}/${input.key}`,
    ]);
    assert.equal(sender.code, 0, sender.stderr);

    const receiverCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        receiver.kill();
        reject(new Error('Vertical RTMP receiver timed out.'));
      }, 10000);
      receiver.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      receiver.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(receiverCode, 0, receiverInfo);
    assert.match(receiverInfo, /s:1080x1920/);
  } finally {
    await relay.stop();
    if (receiver.exitCode === null) receiver.kill();
  }
});

#!/usr/bin/env node
/**
 * 根据删除列表剪辑视频（filter_complex 精确剪辑）— 跨平台 Node.js 版本
 *
 * 用法: node cut_video.js <input.mp4> <delete_segments.json> [output.mp4]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const INPUT = process.argv[2];
const DELETE_JSON = process.argv[3];
const OUTPUT = process.argv[4] || 'output_cut.mp4';

if (!INPUT || !DELETE_JSON) {
  console.error('❌ 用法: node cut_video.js <input.mp4> <delete_segments.json> [output.mp4]');
  process.exit(1);
}
if (!fs.existsSync(INPUT)) {
  console.error(`❌ 找不到输入文件: ${INPUT}`);
  process.exit(1);
}
if (!fs.existsSync(DELETE_JSON)) {
  console.error(`❌ 找不到删除列表: ${DELETE_JSON}`);
  process.exit(1);
}

// file: 前缀：macOS/Linux 文件名可能含冒号，Windows 不需要
function fileArg(p) {
  return process.platform === 'win32' ? p : `file:${p}`;
}

// 获取视频时长
const duration = parseFloat(
  execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fileArg(INPUT)}"`, { encoding: 'utf8' }).trim()
);
console.log(`📹 视频时长: ${duration}s`);

// 配置参数
const BUFFER_MS = 50;
const CROSSFADE_MS = 30;
const bufferSec = BUFFER_MS / 1000;
const crossfadeSec = CROSSFADE_MS / 1000;

console.log(`⚙️ 优化参数: 扩展范围=${BUFFER_MS}ms, 音频crossfade=${CROSSFADE_MS}ms`);

// 读取并处理删除片段
const deleteSegs = JSON.parse(fs.readFileSync(DELETE_JSON, 'utf8'));
deleteSegs.sort((a, b) => a.start - b.start);

// 扩展删除范围
const expandedSegs = deleteSegs.map(seg => ({
  start: Math.max(0, seg.start - bufferSec),
  end: Math.min(duration, seg.end + bufferSec)
}));

// 合并重叠的删除段
const mergedSegs = [];
for (const seg of expandedSegs) {
  if (mergedSegs.length === 0 || seg.start > mergedSegs[mergedSegs.length - 1].end) {
    mergedSegs.push({ ...seg });
  } else {
    mergedSegs[mergedSegs.length - 1].end = Math.max(mergedSegs[mergedSegs.length - 1].end, seg.end);
  }
}

// 计算保留片段
const keepSegs = [];
let cursor = 0;
for (const del of mergedSegs) {
  if (del.start > cursor) {
    keepSegs.push({ start: cursor, end: del.start });
  }
  cursor = del.end;
}
if (cursor < duration) {
  keepSegs.push({ start: cursor, end: duration });
}

console.log(`保留片段数: ${keepSegs.length}`);
console.log(`删除片段数: ${mergedSegs.length}`);

let deletedTime = 0;
for (const seg of mergedSegs) deletedTime += seg.end - seg.start;
console.log(`删除总时长: ${deletedTime.toFixed(2)}s`);

// 生成 filter_complex
const filters = [];
let vconcat = '';
const aLabels = [];

for (let i = 0; i < keepSegs.length; i++) {
  const seg = keepSegs[i];
  filters.push(`[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
  filters.push(`[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
  vconcat += `[v${i}]`;
  aLabels.push(`a${i}`);
}

filters.push(`${vconcat}concat=n=${keepSegs.length}:v=1:a=0[outv]`);

if (keepSegs.length === 1) {
  filters.push('[a0]anull[outa]');
} else {
  let currentLabel = 'a0';
  for (let i = 1; i < keepSegs.length; i++) {
    const nextLabel = `a${i}`;
    const outLabel = (i === keepSegs.length - 1) ? 'outa' : `amid${i}`;
    filters.push(`[${currentLabel}][${nextLabel}]acrossfade=d=${crossfadeSec.toFixed(3)}:c1=tri:c2=tri[${outLabel}]`);
    currentLabel = outLabel;
  }
}

const filterCmd = filters.join(';');

console.log('\n✂️ 执行 FFmpeg 精确剪辑...');

try {
  execSync(
    `ffmpeg -y -i "${fileArg(INPUT)}" -filter_complex "${filterCmd}" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k "${fileArg(OUTPUT)}"`,
    { stdio: 'inherit' }
  );

  const newDuration = parseFloat(
    execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fileArg(OUTPUT)}"`, { encoding: 'utf8' }).trim()
  );
  console.log(`✅ 已保存: ${OUTPUT}`);
  console.log(`📹 新时长: ${newDuration}s`);
} catch (e) {
  console.error('❌ 剪辑失败');
  process.exit(1);
}

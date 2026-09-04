const { spawn } = require('child_process');
const path = require('path');
const { nanoid } = require('nanoid');

const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Platform detection patterns
const YOUTUBE_PATTERNS = [
  /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  /^([a-zA-Z0-9_-]{11})$/  // Direct video ID
];

const VIMEO_PATTERNS = [
  /vimeo\.com\/(\d+)/,
  /player\.vimeo\.com\/video\/(\d+)/
];

// Direct video file extensions
const DIRECT_VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|ogv|mov|mkv|avi|m4v|m3u8|mpd)(\?|$)/i;

/**
 * Detect the type of video URL
 * @param {string} url - The video URL to analyze
 * @returns {{ type: 'iframe' | 'direct' | 'unsupported', platform?: string, videoId?: string }}
 */
function detectUrlType(url) {
  if (!url || typeof url !== 'string') {
    return { type: 'unsupported' };
  }

  const trimmed = url.trim();

  // Check for YouTube
  for (const pattern of YOUTUBE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return { type: 'iframe', platform: 'youtube', videoId: match[1] };
    }
  }

  // Check for Vimeo
  for (const pattern of VIMEO_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return { type: 'iframe', platform: 'vimeo', videoId: match[1] };
    }
  }

  // Check for direct video URL
  if (DIRECT_VIDEO_EXTENSIONS.test(trimmed)) {
    return { type: 'direct' };
  }

  // Check for HTTP/HTTPS URL that might be a direct video
  if (/^https?:\/\//i.test(trimmed)) {
    // Could be a direct video, try to download
    return { type: 'direct' };
  }

  return { type: 'unsupported' };
}

/**
 * Extract YouTube video ID from URL
 * @param {string} url - YouTube URL
 * @returns {string|null} - Video ID or null
 */
function extractYouTubeId(url) {
  const result = detectUrlType(url);
  if (result.type === 'iframe' && result.platform === 'youtube') {
    return result.videoId;
  }
  return null;
}

/**
 * Extract Vimeo video ID from URL
 * @param {string} url - Vimeo URL
 * @returns {string|null} - Video ID or null
 */
function extractVimeoId(url) {
  const result = detectUrlType(url);
  if (result.type === 'iframe' && result.platform === 'vimeo') {
    return result.videoId;
  }
  return null;
}

/**
 * Download video using yt-dlp
 * @param {string} url - Direct video URL
 * @param {object} options - Download options
 * @returns {Promise<{filename: string, originalName: string, url: string}>}
 */
function downloadVideo(url, { onProgress, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const filename = `${nanoid(12)}.mp4`;
    const outputPath = path.join(UPLOAD_DIR, filename);
    
    // First, try to get video info
    const infoArgs = [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      url
    ];

    const infoProcess = spawn('yt-dlp', infoArgs);
    let infoData = '';
    let infoError = '';

    infoProcess.stdout.on('data', (data) => {
      infoData += data.toString();
    });

    infoProcess.stderr.on('data', (data) => {
      infoError += data.toString();
      if (onStderr) onStderr(data.toString());
    });

    infoProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp info failed: ${infoError}`));
      }

      let info;
      try {
        info = JSON.parse(infoData);
      } catch (e) {
        return reject(new Error('Failed to parse video info'));
      }

      const originalName = info.title || info.fulltitle || 'downloaded-video';

      // Now download the video
      const downloadArgs = [
        '--no-playlist',
        '--no-warnings',
        '-f', 'best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', outputPath,
        url
      ];

      const downloadProcess = spawn('yt-dlp', downloadArgs);
      let downloadError = '';

      downloadProcess.stderr.on('data', (data) => {
        const output = data.toString();
        downloadError += output;
        
        // Parse progress from yt-dlp output
        const progressMatch = output.match(/(\d+\.?\d*)%/);
        if (progressMatch && onProgress) {
          onProgress(parseFloat(progressMatch[1]));
        }
        
        if (onStderr) onStderr(output);
      });

      downloadProcess.on('close', (downloadCode) => {
        if (downloadCode !== 0) {
          return reject(new Error(`yt-dlp download failed: ${downloadError}`));
        }

        resolve({
          filename,
          originalName,
          url: `/videos/${filename}`
        });
      });

      downloadProcess.on('error', (err) => {
        reject(new Error(`Failed to start yt-dlp: ${err.message}`));
      });
    });

    infoProcess.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Check if yt-dlp is available
 * @returns {Promise<boolean>}
 */
async function isYtdlpAvailable() {
  return new Promise((resolve) => {
    const process = spawn('yt-dlp', ['--version']);
    let output = '';
    
    process.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    process.on('close', (code) => {
      resolve(code === 0 && output.trim().length > 0);
    });
    
    process.on('error', () => {
      resolve(false);
    });
  });
}

module.exports = {
  detectUrlType,
  extractYouTubeId,
  extractVimeoId,
  downloadVideo,
  isYtdlpAvailable
};

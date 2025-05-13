const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); // To allow frontend from different origins (like localhost:8080) to connect

const app = express();
const port = 3000; // Choose a port for your backend server

// --- Multer Setup for handling file uploads ---
// Store frames in memory (suitable for small videos/testing)
// For production with longer videos, use disk storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- Enable CORS ---
// This allows your frontend HTML file (potentially served from a different origin like http://localhost:8080
// if you use http-server) to make requests to this backend server (on http://localhost:3000).
app.use(cors());

// --- Endpoint to receive frames and encode video ---
// 'frames' matches the field name in the frontend's FormData
app.post('/encode-video', upload.array('frames'), async (req, res) => {
    const frames = req.files; // Array of frame files (Blobs from frontend)
    const fps = req.body.fps || 30; // Get FPS from frontend, default to 30
    const duration = req.body.duration || 5; // Get duration from frontend (in seconds), default to 5

    if (!frames || frames.length === 0) {
        return res.status(400).send('No frames received.');
    }

    console.log(`Received ${frames.length} frames. Encoding ${duration}s video at ${fps} FPS.`);

    // Create a temporary directory for frames and output
    const tempDir = path.join(__dirname, 'temp', Date.now().toString());
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`Created temporary directory: ${tempDir}`);


    const frameFileNamePrefix = 'frame_';
    const frameFileNameSuffix = '.png'; // Assuming frames are PNGs

    // --- Save frames to temporary files ---
    const framePromises = frames.map((frame, index) => {
        const filename = `${frameFileNamePrefix}${String(index).padStart(4, '0')}${frameFileNameSuffix}`;
        const filePath = path.join(tempDir, filename);
        // Multer's memory storage gives us a Buffer in frame.buffer
        return fs.promises.writeFile(filePath, frame.buffer);
    });

    try {
        await Promise.all(framePromises);
        console.log(`Saved ${frames.length} frames to temporary files.`);

        // --- Run FFmpeg ---
        const outputFileName = 'output.mp4';
        const outputFilePath = path.join(tempDir, outputFileName);

        // FFmpeg command arguments
        // -y: Overwrite output file if it exists
        // -framerate: Input frame rate
        // -i: Input file pattern
        // -c:v libx264: Use H.264 encoder
        // -pix_fmt yuv420p: Output pixel format
        // -t: Output duration in seconds (use duration received from frontend)
        // -movflags +faststart: Optimize for web streaming
        // -preset medium: Encoding speed vs compression trade-off
        // -crf 23: Quality setting
        const ffmpegArgs = [
            '-y', // Overwrite output file without asking
            '-framerate', fps.toString(),
            '-i', path.join(tempDir, `${frameFileNamePrefix}%04d${frameFileNameSuffix}`), // Input pattern
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv40', // Try simpler yuv40 or yuv420p - compatibility
             // Depending on environment, you might need a specific encoder like h264_v4l2m2m or h264_nvenc if libx264 is not available
             // '-c:v', 'h264_v4l2m2m', // Example for Raspberry Pi
             // '-c:v', 'h264_nvenc', // Example for Nvidia GPU

            // Use -t for duration control based on frontend input
            '-t', duration.toString(),

            '-movflags', '+faststart',
            '-preset', 'medium', // Or 'fast', 'slow' etc. 'medium' is default
            '-crf', '23', // Adjust for quality/size (18-28 is common)

             // Optional: scale video if needed (e.g., to a standard HD size)
             // '-vf', 'scale=1080:-2', // Example: Scale width to 1080px, height automatic (-2 maintains aspect ratio, must be even)

            outputFilePath // Output file path
        ];

        console.log("Running FFmpeg command:", 'ffmpeg', ffmpegArgs.join(' '));

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        // Log FFmpeg output (for debugging)
        ffmpegProcess.stdout.on('data', (data) => {
            console.log(`FFmpeg stdout: ${data}`);
        });
        ffmpegProcess.stderr.on('data', (data) => {
            console.error(`FFmpeg stderr: ${data}`);
            // You could send this back to the frontend status if needed
        });

        // Wait for FFmpeg process to finish
        ffmpegProcess.on('close', async (code) => {
            if (code === 0) {
                console.log('FFmpeg process finished successfully.');

                // --- Send the output video back to the frontend ---
                try {
                    // Check if output file exists
                    if (!fs.existsSync(outputFilePath)) {
                         throw new Error("FFmpeg did not produce the output file.");
                    }

                    console.log(`Sending file: ${outputFilePath}`);
                    res.download(outputFilePath, 'zodiac_video.mp4', (err) => {
                         if (err) {
                             console.error('Error sending file:', err);
                             // Clean up even on send error
                             cleanupTempDir(tempDir);
                             // Only send error response if headers haven't been sent yet
                             if (!res.headersSent) {
                                res.status(500).send('Error sending video file.');
                             }
                         } else {
                             console.log('File sent successfully.');
                             // Clean up after successful send
                             cleanupTempDir(tempDir);
                         }
                    });

                } catch (e) {
                    console.error('Error reading/sending output file:', e);
                     // Clean up on error
                     cleanupTempDir(tempDir);
                    res.status(500).send(`Error processing output file: ${e.message}`);
                }

            } else {
                console.error(`FFmpeg process exited with code ${code}`);
                 // Clean up on error
                 cleanupTempDir(tempDir);
                res.status(500).send(`Video encoding failed (FFmpeg exited with code ${code}). Check backend logs.`);
            }
        });

    } catch (error) {
        console.error('Error saving frames or starting FFmpeg:', error);
         // Clean up on error
         cleanupTempDir(tempDir);
        res.status(500).send(`Server error: ${error.message}`);
    }
});


// --- Helper to clean up the temporary directory ---
function cleanupTempDir(dirPath) {
    console.log(`Cleaning up directory: ${dirPath}`);
    fs.rm(dirPath, { recursive: true, force: true }, (err) => {
        if (err) {
            console.error(`Error cleaning up temp directory ${dirPath}:`, err);
        } else {
            console.log(`Cleaned up ${dirPath}`);
        }
    });
}


// --- Start the server ---
app.listen(port, () => {
    console.log(`Backend server listening at http://localhost:${port}`);
    console.log(`Ensure FFmpeg is installed and in your system's PATH.`);
});

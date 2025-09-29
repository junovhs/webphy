import { Spin, Upload, Button, message } from "antd";
import { useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { InboxOutlined } from "@ant-design/icons";
import { fileTypeFromBuffer } from "file-type";
import { Analytics } from "@vercel/analytics/react";

const { Dragger } = Upload;

const App = () => {
  const [spinning, setSpinning] = useState(false);
  const [tip, setTip] = useState(false);
  const [file, setFile] = useState();
  const [fileList, setFileList] = useState([]);
  const [name, setName] = useState("input.mp4");
  const [href, setHref] = useState("");
  const [downloadFileName, setDownloadFileName] = useState("output.mp3");
  const ffmpegRef = useRef(null);

  const handleExec = async () => {
    if (!file || !ffmpegRef.current) {
      message.error("Please select an MP4 file first and wait for FFmpeg to load.");
      return;
    }
    setHref("");
    setDownloadFileName("");
    try {
      setTip("Loading file into browser");
      setSpinning(true);
      await ffmpegRef.current.writeFile(name, await fetchFile(file));
      setTip("Starting conversion to MP3...");
      // Hardcoded MP3 conversion: extract audio only, high quality MP3
      await ffmpegRef.current.exec([
        "-i", name,
        "-vn", // No video
        "-acodec", "libmp3lame",
        "-q:a", "2", // High quality (VBR ~190kbps)
        "output.mp3"
      ]);
      setTip("Generating download...");
      const data = await ffmpegRef.current.readFile("output.mp3");
      const type = await fileTypeFromBuffer(data.buffer);

      const objectURL = URL.createObjectURL(
        new Blob([data.buffer], { type: type.mime })
      );
      setHref(objectURL);
      setDownloadFileName("output.mp3");
      setSpinning(false);
      message.success(
        "Conversion successful! Click the download button to get your MP3.",
        10
      );
    } catch (err) {
      console.error(err);
      setSpinning(false);
      message.error(
        "Conversion failed. Check the console for details or try a smaller file.",
        10
      );
    }
  };

  useEffect(() => {
    (async () => {
      const ffmpeg = new FFmpeg();
      ffmpegRef.current = ffmpeg;

      ffmpeg.on("log", ({ message: logMessage }) => {
        console.log(logMessage);
      });
      ffmpeg.on("progress", ({ progress }) => {
        console.log("Progress: " + Math.round(progress * 100) + "%");
        setTip("Converting: " + Math.round(progress * 100) + "%");
      });

      setTip("Loading FFmpeg library (~31MB)...");
      setSpinning(true);
      try {
        await ffmpeg.load({
          coreURL: '/ffmpeg-core.js',
          wasmURL: '/ffmpeg-core.wasm',
          workerURL: '/ffmpeg-worker.js'  // Optional: Add if you download it
        });
        setSpinning(false);
        setTip("Ready! Upload an MP4 to convert to MP3.");
      } catch (error) {
        console.error("FFmpeg load failed:", error);
        setSpinning(false);
        message.error("Failed to load FFmpeg. Check console.");
      }
    })();
  }, []);

  return (
    <div className="page-app">
      {spinning && (
        <Spin spinning={spinning} tip={tip}>
          <div className="component-spin" />
        </Spin>
      )}

      <h2 align="center">MP4 to MP3 Converter</h2>
      <p style={{ color: "gray", textAlign: "center" }}>
        Powered by FFmpeg.wasm – processes files entirely in your browser (no upload to server).
      </p>

      <h4>1. Select MP4 File</h4>
      <Dragger
        multiple={false}
        accept="video/mp4"
        beforeUpload={(file) => {
          setFile(file);
          setFileList([file]);
          setName(file.name);
          message.success(`${file.name} selected for conversion.`);
          return false;
        }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">Click or drag your MP4 file here</p>
        <p className="ant-upload-hint">Supports MP4 files up to ~100MB (browser memory limits apply).</p>
      </Dragger>

      <h4>2. Convert to MP3</h4>
      <div className="exec">
        <div className="command-text">
          ffmpeg -i {name} -vn -acodec libmp3lame -q:a 2 output.mp3
        </div>
        <p style={{ color: "gray", fontSize: "12px" }}>
          (Extracts audio only, high-quality MP3 ~190kbps)
        </p>
      </div>

      <h4>3. Download MP3</h4>
      <Button type="primary" disabled={!Boolean(file)} onClick={handleExec} block>
        Convert to MP3
      </Button>
      <br />
      <br />
      {href && (
        <a href={href} download={downloadFileName}>
          <Button type="success" block>Download {downloadFileName}</Button>
        </a>
      )}

      <br />
      <br />
      <a
        href="https://github.com/xiguaxigua/ffmpeg-online"
        target="_blank"
        className="github-corner"
        aria-label="View source on GitHub"
        rel="noreferrer"
      >
        <svg
          width="80"
          height="80"
          viewBox="0 0 250 250"
          style={{
            fill: "#151513",
            color: "#fff",
            position: "absolute",
            top: 0,
            border: 0,
            right: 0,
          }}
          aria-hidden="true"
        >
          <path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
          <path
            d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2"
            fill="currentColor"
            style={{
              transformOrigin: "130px 106px",
            }}
            className="octo-arm"
          ></path>
          <path
            d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z"
            fill="currentColor"
            className="octo-body"
          ></path>
        </svg>
      </a>
      <Analytics />
    </div>
  );
};

export default App;
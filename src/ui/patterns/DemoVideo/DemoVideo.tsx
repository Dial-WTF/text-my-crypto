"use client";

import { useRef, useState } from "react";
import styles from "./DemoVideo.module.css";

type DemoVideoProps = {
  /** The MP4s to try in order: the media domain first, then this site's own copy. */
  sources: readonly string[];
  /** A still from the video, shown until it plays. */
  poster: string;
  /** WebVTT captions of the narration. */
  captions: string;
  /** What the video shows, in one line under it. */
  caption: string;
};

/**
 * A recorded product demo. Nothing loads until someone presses play: a large button over the poster, and a click
 * anywhere on it, starts the video; the browser's own controls take over once it plays.
 */
export function DemoVideo({ sources, poster, captions, caption }: DemoVideoProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const play = () => {
    setStarted(true);
    void video.current?.play();
  };
  return (
    <figure className={styles.figure}>
      <div className={styles.frame}>
        <video
          ref={video}
          className={styles.video}
          controls={started}
          preload="none"
          playsInline
          poster={poster}
          width={1920}
          height={1080}
          onPlay={() => setStarted(true)}
        >
          {sources.map((src) => (
            <source key={src} src={src} type="video/mp4" />
          ))}
          <track kind="captions" src={captions} srcLang="en" label="English" />
        </video>
        {started ? null : (
          <button type="button" className={styles.play} onClick={play} aria-label="Play the demo video">
            <span className={styles.icon} aria-hidden />
          </button>
        )}
      </div>
      <figcaption className={styles.caption}>{caption}</figcaption>
    </figure>
  );
}

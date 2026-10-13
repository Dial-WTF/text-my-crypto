import styles from "./DemoVideo.module.css";

type DemoVideoProps = {
  /** The MP4, served from this site. */
  src: string;
  /** A still from the video, shown until it plays. */
  poster: string;
  /** WebVTT captions of the narration. */
  captions: string;
  /** What the video shows, in one line under it. */
  caption: string;
};

/** A recorded product demo. Nothing loads until someone presses play. */
export function DemoVideo({ src, poster, captions, caption }: DemoVideoProps) {
  return (
    <figure className={styles.figure}>
      <video className={styles.video} controls preload="none" playsInline poster={poster} width={1920} height={1080}>
        <source src={src} type="video/mp4" />
        <track kind="captions" src={captions} srcLang="en" label="English" />
      </video>
      <figcaption className={styles.caption}>{caption}</figcaption>
    </figure>
  );
}

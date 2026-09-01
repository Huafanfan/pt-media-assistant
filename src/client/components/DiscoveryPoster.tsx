import { ImageOff } from "lucide-react";
import { useEffect, useState } from "react";

export type DiscoveryPosterProps = {
  src?: string;
  title: string;
  alt?: string;
  className?: string;
};

export function DiscoveryPoster({ src, title, alt = "", className = "" }: DiscoveryPosterProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <span className={`discovery-poster ${className}`.trim()}>
      {src && !failed ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="discovery-poster-placeholder" aria-hidden="true">
          <ImageOff size={19} strokeWidth={1.6} />
          <span>{title.slice(0, 1)}</span>
        </span>
      )}
    </span>
  );
}

export default DiscoveryPoster;

import React from 'react';

type SiteBrandMarkProps = {
  size?: 32 | 40;
  className?: string;
};

const BRAND_ASSETS = {
  32: {
    webp: '/images/brand/oblivion-agent-icon-32.webp',
    png: '/images/brand/oblivion-agent-icon-32.png',
  },
  40: {
    webp: '/images/brand/oblivion-agent-icon-40.webp',
    png: '/images/brand/oblivion-agent-icon-40.png',
    webp2x: '/images/brand/oblivion-agent-icon-80.webp',
  },
} as const;

export default function SiteBrandMark({
  size = 40,
  className = '',
}: SiteBrandMarkProps): React.ReactElement {
  const assets = BRAND_ASSETS[size];
  const webpSrcSet =
    size === 40 && 'webp2x' in assets
      ? `${assets.webp} 1x, ${assets.webp2x} 2x`
      : assets.webp;

  return (
    <picture className={className}>
      <source type="image/webp" srcSet={webpSrcSet} />
      <img
        src={assets.png}
        alt=""
        width={size}
        height={size}
        className="logo-image"
        loading="eager"
        decoding="async"
      />
    </picture>
  );
}
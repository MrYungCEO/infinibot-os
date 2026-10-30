// Thin wrapper over expo-video (expo-av was removed in Expo SDK 55): one
// player per mounted view, native controls, letterboxed.
import React, { useEffect } from 'react';
import { useVideoPlayer, VideoView } from 'expo-video';

export default function VideoPlayerView({ uri, headers, style, autoPlay = false, loop = false, onError }) {
  const player = useVideoPlayer(headers ? { uri, headers } : { uri }, (p) => {
    p.loop = loop;
    if (autoPlay) p.play();
  });

  useEffect(() => {
    if (!onError) return undefined;
    const sub = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'error') onError(error);
    });
    return () => sub.remove();
  }, [player, onError]);

  return <VideoView player={player} style={style} nativeControls contentFit="contain" />;
}

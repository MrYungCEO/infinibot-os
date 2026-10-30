/**
 * useImageAttach — the chat composers' "attach an image" flow (camera or
 * library on devices, file picker on web), shared by ChatComposer (1:1) and
 * GroupComposer (group chats). Picked images are `{ uri, base64, mimeType }`,
 * which useChatSync / useGroupChat send as chat.send-style attachments.
 */
import { useCallback, useState } from 'react';
import { Alert, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { tap } from '../utils/haptics';

export function useImageAttach(onPicked) {
  const [picking, setPicking] = useState(false);

  const pick = useCallback(async (fromCamera) => {
    if (picking) return;
    setPicking(true);
    try {
      const perm = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert('Permission needed', fromCamera ? 'Allow camera access to take a photo.' : 'Allow photo access to attach an image.');
        return;
      }
      const opts = { allowsEditing: false, quality: 0.8, base64: true, exif: false };
      const res = fromCamera
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync({ ...opts, mediaTypes: ['images'] });
      const asset = !res.canceled && res.assets?.[0];
      if (asset) onPicked({ uri: asset.uri, base64: asset.base64, mimeType: asset.mimeType || 'image/jpeg' });
    } catch (err) {
      Alert.alert('Could not attach the image', String(err?.message || err));
    } finally {
      setPicking(false);
    }
  }, [picking, onPicked]);

  const attach = useCallback(() => {
    tap();
    if (Platform.OS === 'web') return pick(false);
    Alert.alert('Attach an image', undefined, [
      { text: 'Take photo', onPress: () => pick(true) },
      { text: 'Choose from library', onPress: () => pick(false) },
      { text: 'Cancel', style: 'cancel' },
    ]);
    return undefined;
  }, [pick]);

  return { attach, picking };
}

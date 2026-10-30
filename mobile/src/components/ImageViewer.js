import React, { useState, useRef } from 'react';
import {
  View,
  Modal,
  Image,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Animated,
  Dimensions,
  ActivityIndicator,
  Text,
  Alert,
  Platform,
  Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import * as MediaLibrary from 'expo-media-library/legacy';
import { File, Paths } from 'expo-file-system';
import { COLORS, FONTS, SPACING } from '../constants/theme';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

/**
 * Full-screen image viewer with zoom, pan, and actions
 */
export function ImageViewer({ visible, imageUri, onClose, images = [], initialIndex = 0 }) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Use images array if provided, otherwise single image
  const imageList = images.length > 0 ? images : (imageUri ? [imageUri] : []);
  const currentImage = imageList[currentIndex];

  React.useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    } else {
      fadeAnim.setValue(0);
    }
  }, [visible, initialIndex]);

  const handleClose = () => {
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 150,
      useNativeDriver: true,
    }).start(() => onClose());
  };

  const handlePrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setLoading(true);
    }
  };

  const handleNext = () => {
    if (currentIndex < imageList.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setLoading(true);
    }
  };

  const handleSaveImage = async () => {
    if (!currentImage) return;
    
    setSaving(true);
    try {
      // Request permissions
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Please grant access to save images to your photo library.');
        setSaving(false);
        return;
      }

      // Download if remote URL
      let localUri = currentImage;
      if (currentImage.startsWith('http')) {
        const filename = `moltbot_${Date.now()}.jpg`;
        const file = await File.downloadFileAsync(currentImage, new File(Paths.cache, filename));
        localUri = file.uri;
      }

      // Save to media library
      await MediaLibrary.saveToLibraryAsync(localUri);
      Alert.alert('Saved!', 'Image saved to your photo library.');
    } catch (error) {
      console.error('Save error:', error);
      Alert.alert('Error', 'Failed to save image. Please try again.');
    }
    setSaving(false);
  };

  const handleShare = async () => {
    if (!currentImage) return;
    
    try {
      await Share.share({
        url: currentImage,
        message: Platform.OS === 'android' ? currentImage : undefined,
      });
    } catch (error) {
      console.error('Share error:', error);
    }
  };

  const handleDoubleTap = () => {
    // Toggle zoom on double tap
    Animated.spring(scale, {
      toValue: scale._value > 1 ? 1 : 2,
      useNativeDriver: true,
      friction: 5,
    }).start();
  };

  if (!visible || imageList.length === 0) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <BlurView intensity={95} tint="dark" style={styles.blur}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity style={styles.headerBtn} onPress={handleClose}>
              <Ionicons name="close" size={28} color="#fff" />
            </TouchableOpacity>
            
            {imageList.length > 1 && (
              <Text style={styles.counter}>
                {currentIndex + 1} / {imageList.length}
              </Text>
            )}
            
            <View style={styles.headerActions}>
              <TouchableOpacity 
                style={styles.headerBtn} 
                onPress={handleShare}
              >
                <Ionicons name="share-outline" size={24} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.headerBtn} 
                onPress={handleSaveImage}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="download-outline" size={24} color="#fff" />
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* Image Container */}
          <TouchableWithoutFeedback onPress={handleDoubleTap}>
            <View style={styles.imageContainer}>
              {loading && (
                <View style={styles.loadingOverlay}>
                  <ActivityIndicator size="large" color={COLORS.primary} />
                </View>
              )}
              
              <Animated.Image
                source={{ uri: currentImage }}
                style={[
                  styles.image,
                  {
                    transform: [
                      { scale },
                      { translateX },
                      { translateY },
                    ],
                  },
                ]}
                resizeMode="contain"
                onLoadStart={() => setLoading(true)}
                onLoadEnd={() => setLoading(false)}
                onError={() => {
                  setLoading(false);
                  Alert.alert('Error', 'Failed to load image');
                }}
              />

              {/* Navigation Arrows */}
              {imageList.length > 1 && (
                <>
                  {currentIndex > 0 && (
                    <TouchableOpacity 
                      style={[styles.navBtn, styles.navBtnLeft]}
                      onPress={handlePrevious}
                    >
                      <Ionicons name="chevron-back" size={36} color="#fff" />
                    </TouchableOpacity>
                  )}
                  {currentIndex < imageList.length - 1 && (
                    <TouchableOpacity 
                      style={[styles.navBtn, styles.navBtnRight]}
                      onPress={handleNext}
                    >
                      <Ionicons name="chevron-forward" size={36} color="#fff" />
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
          </TouchableWithoutFeedback>

          {/* Thumbnail Strip for multiple images */}
          {imageList.length > 1 && (
            <View style={styles.thumbnailStrip}>
              {imageList.map((uri, index) => (
                <TouchableOpacity
                  key={index}
                  style={[
                    styles.thumbnail,
                    index === currentIndex && styles.thumbnailActive,
                  ]}
                  onPress={() => {
                    setCurrentIndex(index);
                    setLoading(true);
                  }}
                >
                  <Image
                    source={{ uri }}
                    style={styles.thumbnailImage}
                    resizeMode="cover"
                  />
                </TouchableOpacity>
              ))}
            </View>
          )}
        </BlurView>
      </Animated.View>
    </Modal>
  );
}

/**
 * Tappable image component that opens the viewer
 */
export function TappableImage({ uri, style, images = [], index = 0, resizeMode = 'cover' }) {
  const [viewerVisible, setViewerVisible] = useState(false);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  return (
    <>
      <TouchableOpacity 
        activeOpacity={0.9} 
        onPress={() => setViewerVisible(true)}
        style={[styles.tappableContainer, style]}
      >
        {imageLoading && (
          <View style={styles.imagePlaceholder}>
            <ActivityIndicator size="small" color={COLORS.primary} />
          </View>
        )}
        {imageError ? (
          <View style={styles.imageErrorContainer}>
            <Ionicons name="image-outline" size={32} color={COLORS.textMuted} />
            <Text style={styles.imageErrorText}>Failed to load</Text>
          </View>
        ) : (
          <Image
            source={{ uri }}
            style={[styles.tappableImage, style, imageLoading && { opacity: 0 }]}
            resizeMode={resizeMode}
            onLoadStart={() => setImageLoading(true)}
            onLoadEnd={() => setImageLoading(false)}
            onError={() => {
              setImageLoading(false);
              setImageError(true);
            }}
          />
        )}
        <View style={styles.zoomHint}>
          <Ionicons name="expand-outline" size={16} color="#fff" />
        </View>
      </TouchableOpacity>

      <ImageViewer
        visible={viewerVisible}
        imageUri={uri}
        images={images}
        initialIndex={index}
        onClose={() => setViewerVisible(false)}
      />
    </>
  );
}

/**
 * Image grid for multiple images in a message
 */
export function ImageGrid({ images, maxDisplay = 4 }) {
  const [viewerVisible, setViewerVisible] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  
  if (!images || images.length === 0) return null;
  
  const displayImages = images.slice(0, maxDisplay);
  const remainingCount = images.length - maxDisplay;

  const openViewer = (index) => {
    setSelectedIndex(index);
    setViewerVisible(true);
  };

  // Single image
  if (images.length === 1) {
    return (
      <>
        <TappableImage 
          uri={images[0]} 
          style={styles.singleImage}
          images={images}
          index={0}
          resizeMode="contain"
        />
      </>
    );
  }

  // Grid layout
  return (
    <>
      <View style={[
        styles.grid,
        images.length === 2 && styles.gridTwo,
        images.length === 3 && styles.gridThree,
        images.length >= 4 && styles.gridFour,
      ]}>
        {displayImages.map((uri, index) => (
          <TouchableOpacity
            key={index}
            style={[
              styles.gridItem,
              images.length === 2 && styles.gridItemHalf,
              images.length === 3 && index === 0 && styles.gridItemLarge,
              images.length >= 4 && styles.gridItemQuarter,
            ]}
            activeOpacity={0.9}
            onPress={() => openViewer(index)}
          >
            <Image
              source={{ uri }}
              style={styles.gridImage}
              resizeMode="cover"
            />
            {index === maxDisplay - 1 && remainingCount > 0 && (
              <View style={styles.remainingOverlay}>
                <Text style={styles.remainingText}>+{remainingCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      <ImageViewer
        visible={viewerVisible}
        images={images}
        initialIndex={selectedIndex}
        onClose={() => setViewerVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  blur: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
  },
  headerBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  counter: {
    ...FONTS.medium,
    color: '#fff',
    fontSize: 16,
  },
  imageContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.7,
  },
  navBtn: {
    position: 'absolute',
    top: '50%',
    marginTop: -30,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBtnLeft: {
    left: 10,
  },
  navBtnRight: {
    right: 10,
  },
  thumbnailStrip: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingVertical: SPACING.md,
    paddingBottom: Platform.OS === 'ios' ? 40 : SPACING.md,
    gap: 8,
  },
  thumbnail: {
    width: 60,
    height: 60,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbnailActive: {
    borderColor: COLORS.primary,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  
  // Tappable Image styles
  tappableContainer: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 12,
  },
  tappableImage: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  imageErrorContainer: {
    width: '100%',
    height: 150,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  imageErrorText: {
    ...FONTS.small,
    color: COLORS.textMuted,
    marginTop: 8,
  },
  zoomHint: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Grid styles
  singleImage: {
    width: '100%',
    height: 250,
    borderRadius: 12,
    marginTop: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    gap: 4,
    borderRadius: 12,
    overflow: 'hidden',
  },
  gridTwo: {},
  gridThree: {},
  gridFour: {},
  gridItem: {
    overflow: 'hidden',
  },
  gridItemHalf: {
    width: '49%',
    height: 150,
  },
  gridItemLarge: {
    width: '100%',
    height: 150,
  },
  gridItemQuarter: {
    width: '49%',
    height: 120,
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  remainingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  remainingText: {
    ...FONTS.bold,
    color: '#fff',
    fontSize: 24,
  },
});

/**
 * BlockRenderer — Renders Notion blocks as React Native components
 * Supports headings, paragraphs, lists, tables, callouts, etc.
 */
import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Linking, Image as RNImage
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';

// Render a single block
function Block({ block, depth = 0, index = 0 }) {
  const indent = depth * 16;
  
  switch (block.type) {
    case 'paragraph':
      if (!block.text) return null;
      return (
        <View style={[styles.block, { marginLeft: indent }]}>
          <Text style={styles.paragraph}>{block.text}</Text>
          {block.children?.map((child, i) => (
            <Block key={child.id || i} block={child} depth={depth + 1} index={i} />
          ))}
        </View>
      );
    
    case 'heading_1':
      return (
        <View style={[styles.block, { marginLeft: indent }]}>
          <Text style={styles.heading1}>{block.text}</Text>
        </View>
      );
    
    case 'heading_2':
      return (
        <View style={[styles.block, { marginLeft: indent }]}>
          <Text style={styles.heading2}>{block.text}</Text>
        </View>
      );
    
    case 'heading_3':
      return (
        <View style={[styles.block, { marginLeft: indent }]}>
          <Text style={styles.heading3}>{block.text}</Text>
        </View>
      );
    
    case 'bulleted_list_item':
      return (
        <View style={[styles.listItem, { marginLeft: indent }]}>
          <Text style={styles.bullet}>•</Text>
          <View style={styles.listContent}>
            <Text style={styles.listText}>{block.text}</Text>
            {block.children?.map((child, i) => (
              <Block key={child.id || i} block={child} depth={depth + 1} index={i} />
            ))}
          </View>
        </View>
      );
    
    case 'numbered_list_item':
      return (
        <View style={[styles.listItem, { marginLeft: indent }]}>
          <Text style={styles.number}>{index + 1}.</Text>
          <View style={styles.listContent}>
            <Text style={styles.listText}>{block.text}</Text>
            {block.children?.map((child, i) => (
              <Block key={child.id || i} block={child} depth={depth + 1} index={i} />
            ))}
          </View>
        </View>
      );
    
    case 'to_do':
      return (
        <View style={[styles.todoItem, { marginLeft: indent }]}>
          <View style={[styles.checkbox, block.checked && styles.checkboxChecked]}>
            {block.checked && <Ionicons name="checkmark" size={12} color={COLORS.primary} />}
          </View>
          <Text style={[styles.todoText, block.checked && styles.todoTextChecked]}>
            {block.text}
          </Text>
        </View>
      );
    
    case 'toggle':
      return (
        <View style={[styles.toggle, { marginLeft: indent }]}>
          <View style={styles.toggleHeader}>
            <Ionicons name="chevron-forward" size={14} color={COLORS.textMuted} />
            <Text style={styles.toggleText}>{block.text}</Text>
          </View>
          {block.children?.map((child, i) => (
            <Block key={child.id || i} block={child} depth={depth + 1} index={i} />
          ))}
        </View>
      );
    
    case 'quote':
      return (
        <View style={[styles.quote, { marginLeft: indent }]}>
          <View style={styles.quoteBorder} />
          <Text style={styles.quoteText}>{block.text}</Text>
        </View>
      );
    
    case 'callout':
      return (
        <View style={[styles.callout, { marginLeft: indent }]}>
          {block.icon ? (
            <Text style={styles.calloutIcon}>{block.icon}</Text>
          ) : block.iconName ? (
            <Ionicons name={block.iconName} size={16} color={COLORS.primary} style={styles.calloutIcon} />
          ) : (
            <Text style={styles.calloutIcon}>{block.icon}</Text>
          )}
          <View style={styles.calloutContent}>
            <Text style={styles.calloutText}>{block.text}</Text>
            {block.children?.map((child, i) => (
              <Block key={child.id || i} block={child} depth={depth + 1} index={i} />
            ))}
          </View>
        </View>
      );
    
    case 'divider':
      return (
        <View style={[styles.divider, { marginLeft: indent }]}>
          <View style={styles.dividerLine} />
        </View>
      );
    
    case 'code':
      return (
        <View style={[styles.codeBlock, { marginLeft: indent }]}>
          {block.language && (
            <Text style={styles.codeLanguage}>{block.language}</Text>
          )}
          <Text style={styles.codeText}>{block.text}</Text>
        </View>
      );
    
    case 'table':
      return (
        <View style={[styles.table, { marginLeft: indent }]}>
          {block.children?.map((row, rowIndex) => (
            <View 
              key={row.id || rowIndex} 
              style={[
                styles.tableRow,
                rowIndex === 0 && block.hasColumnHeader && styles.tableHeaderRow
              ]}
            >
              {row.cells?.map((cell, cellIndex) => (
                <View 
                  key={cellIndex} 
                  style={[
                    styles.tableCell,
                    cellIndex === 0 && block.hasRowHeader && styles.tableHeaderCell
                  ]}
                >
                  <Text style={[
                    styles.tableCellText,
                    (rowIndex === 0 && block.hasColumnHeader) && styles.tableHeaderText
                  ]}>
                    {cell}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    
    case 'image':
      if (!block.url) return null;
      return (
        <View style={[styles.imageBlock, { marginLeft: indent }]}>
          <RNImage 
            source={{ uri: block.url }} 
            style={styles.image}
            resizeMode="contain"
          />
          {block.caption && (
            <Text style={styles.caption}>{block.caption}</Text>
          )}
        </View>
      );
    
    case 'pdf':
    case 'file':
      return (
        <TouchableOpacity 
          style={[styles.fileBlock, { marginLeft: indent }]}
          onPress={() => block.url && Linking.openURL(block.url)}
        >
          <Ionicons 
            name={block.type === 'pdf' ? 'document-text' : 'document'} 
            size={24} 
            color={COLORS.primary} 
          />
          <View style={styles.fileInfo}>
            <Text style={styles.fileName}>{block.name || 'File'}</Text>
            {block.caption && (
              <Text style={styles.fileCaption}>{block.caption}</Text>
            )}
          </View>
          <Ionicons name="open-outline" size={16} color={COLORS.textMuted} />
        </TouchableOpacity>
      );
    
    case 'bookmark':
    case 'embed':
      return (
        <TouchableOpacity 
          style={[styles.bookmark, { marginLeft: indent }]}
          onPress={() => block.url && Linking.openURL(block.url)}
        >
          <Ionicons name="link" size={18} color={COLORS.primary} />
          <View style={styles.bookmarkInfo}>
            <Text style={styles.bookmarkUrl} numberOfLines={1}>{block.url}</Text>
            {block.caption && (
              <Text style={styles.bookmarkCaption}>{block.caption}</Text>
            )}
          </View>
        </TouchableOpacity>
      );
    
    case 'video':
      return (
        <TouchableOpacity 
          style={[styles.videoBlock, { marginLeft: indent }]}
          onPress={() => block.url && Linking.openURL(block.url)}
        >
          <Ionicons name="play-circle" size={40} color={COLORS.primary} />
          <Text style={styles.videoText}>Video</Text>
          {block.caption && (
            <Text style={styles.caption}>{block.caption}</Text>
          )}
        </TouchableOpacity>
      );
    
    case 'child_page':
      return (
        <View style={[styles.childPage, { marginLeft: indent }]}>
          <Ionicons name="document" size={16} color={COLORS.textMuted} />
          <Text style={styles.childPageTitle}>{block.title || 'Untitled'}</Text>
        </View>
      );
    
    case 'child_database':
      return (
        <View style={[styles.childDatabase, { marginLeft: indent }]}>
          <Ionicons name="grid" size={16} color={COLORS.textMuted} />
          <Text style={styles.childDatabaseTitle}>{block.title || 'Untitled Database'}</Text>
        </View>
      );
    
    case 'column_list':
      return (
        <View style={[styles.columnList, { marginLeft: indent }]}>
          {block.children?.map((col, i) => (
            <View key={col.id || i} style={styles.column}>
              {col.children?.map((child, j) => (
                <Block key={child.id || j} block={child} depth={0} index={j} />
              ))}
            </View>
          ))}
        </View>
      );
    
    default:
      // Unknown block type - render children if any
      if (block.children?.length > 0) {
        return (
          <View style={{ marginLeft: indent }}>
            {block.children.map((child, i) => (
              <Block key={child.id || i} block={child} depth={depth + 1} index={i} />
            ))}
          </View>
        );
      }
      return null;
  }
}

// Main block list renderer
export function BlockRenderer({ blocks, style }) {
  if (!blocks || blocks.length === 0) return null;
  
  // Group consecutive list items for proper numbering
  const groupedBlocks = [];
  let currentGroup = null;
  let numberIndex = 0;
  
  for (const block of blocks) {
    if (block.type === 'numbered_list_item') {
      if (currentGroup?.type !== 'numbered_list_item') {
        numberIndex = 0;
      }
      groupedBlocks.push({ ...block, listIndex: numberIndex });
      numberIndex++;
      currentGroup = block;
    } else {
      numberIndex = 0;
      groupedBlocks.push(block);
      currentGroup = block;
    }
  }
  
  return (
    <View style={[styles.container, style]}>
      {groupedBlocks.map((block, i) => (
        <Block 
          key={block.id || i} 
          block={block} 
          depth={0} 
          index={block.listIndex ?? i} 
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  block: {
    marginBottom: 8,
  },
  
  // Text
  paragraph: {
    fontSize: 14,
    lineHeight: 22,
    color: COLORS.text,
  },
  heading1: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.text,
    marginTop: 20,
    marginBottom: 12,
  },
  heading2: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.text,
    marginTop: 16,
    marginBottom: 10,
  },
  heading3: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    marginTop: 12,
    marginBottom: 8,
  },
  
  // Lists
  listItem: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  bullet: {
    width: 20,
    fontSize: 14,
    color: COLORS.textMuted,
  },
  number: {
    width: 24,
    fontSize: 14,
    color: COLORS.textMuted,
  },
  listContent: {
    flex: 1,
  },
  listText: {
    fontSize: 14,
    lineHeight: 22,
    color: COLORS.text,
  },
  
  // To-do
  todoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 10,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderWidth: 1,
    borderColor: COLORS.primaryStrong,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: COLORS.primaryLight,
    borderColor: COLORS.primary,
  },
  todoText: {
    flex: 1,
    fontSize: 14,
    color: COLORS.text,
  },
  todoTextChecked: {
    textDecorationLine: 'line-through',
    color: COLORS.textMuted,
  },
  
  // Toggle
  toggle: {
    marginBottom: 8,
  },
  toggleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  toggleText: {
    fontSize: 14,
    color: COLORS.text,
  },
  
  // Quote
  quote: {
    flexDirection: 'row',
    marginVertical: 8,
  },
  quoteBorder: {
    width: 3,
    backgroundColor: COLORS.primaryStrong,
    marginRight: 12,
    borderRadius: 2,
  },
  quoteText: {
    flex: 1,
    fontSize: 14,
    fontStyle: 'italic',
    color: COLORS.textMuted,
    lineHeight: 22,
  },
  
  // Callout
  callout: {
    flexDirection: 'row',
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
    gap: 10,
  },
  calloutIcon: {
    fontSize: 18,
  },
  calloutContent: {
    flex: 1,
  },
  calloutText: {
    fontSize: 14,
    color: COLORS.text,
    lineHeight: 22,
  },
  
  // Divider
  divider: {
    marginVertical: 16,
  },
  dividerLine: {
    height: 1,
    backgroundColor: COLORS.primaryLight,
  },
  
  // Code
  codeBlock: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 6,
    padding: 12,
    marginVertical: 8,
  },
  codeLanguage: {
    fontSize: 10,
    color: COLORS.goldDim,
    letterSpacing: 1,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  codeText: {
    fontSize: 13,
    fontFamily: 'monospace',
    color: '#e5e5e5',
    lineHeight: 20,
  },
  
  // Table
  table: {
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
    borderRadius: 6,
    overflow: 'hidden',
    marginVertical: 8,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  tableHeaderRow: {
    backgroundColor: COLORS.primaryDim,
  },
  tableCell: {
    flex: 1,
    padding: 10,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.05)',
  },
  tableHeaderCell: {
    backgroundColor: COLORS.primaryDim,
  },
  tableCellText: {
    fontSize: 12,
    color: COLORS.text,
  },
  tableHeaderText: {
    fontWeight: '700',
    color: COLORS.primary,
  },
  
  // Image
  imageBlock: {
    marginVertical: 12,
  },
  image: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  caption: {
    fontSize: 12,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: 6,
  },
  
  // File
  fileBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
    gap: 12,
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '600',
  },
  fileCaption: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  
  // Bookmark
  bookmark: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
    gap: 10,
  },
  bookmarkInfo: {
    flex: 1,
  },
  bookmarkUrl: {
    fontSize: 13,
    color: COLORS.primary,
  },
  bookmarkCaption: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  
  // Video
  videoBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 8,
    padding: 30,
    marginVertical: 12,
  },
  videoText: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 8,
  },
  
  // Child page/database
  childPage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  childPageTitle: {
    fontSize: 14,
    color: COLORS.text,
  },
  childDatabase: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  childDatabaseTitle: {
    fontSize: 14,
    color: COLORS.text,
  },
  
  // Columns
  columnList: {
    flexDirection: 'row',
    gap: 16,
    marginVertical: 8,
  },
  column: {
    flex: 1,
  },
});

export default BlockRenderer;

/**
 * ScheduleScreen — Google Calendar integration with agenda/day/week views
 * Matches web UI gold/black HUD theme
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  FlatList, Modal, Alert, useWindowDimensions, ActivityIndicator, RefreshControl
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GLASS } from '../constants/theme';
import { useCalendar, formatEventTime, isEventInProgress, getEventColor } from '../hooks/useCalendar';

export function ScheduleScreen({ gateway }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  
  const calendar = useCalendar(gateway);
  const [quickAddText, setQuickAddText] = useState('');
  const [showEventModal, setShowEventModal] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);

  // Navigation
  const navigatePrev = () => {
    const newDate = new Date(calendar.selectedDate);
    if (calendar.view === 'day') newDate.setDate(newDate.getDate() - 1);
    else if (calendar.view === 'week') newDate.setDate(newDate.getDate() - 7);
    else if (calendar.view === 'month') newDate.setMonth(newDate.getMonth() - 1);
    else newDate.setDate(newDate.getDate() - 7);
    calendar.setSelectedDate(newDate);
  };

  const navigateNext = () => {
    const newDate = new Date(calendar.selectedDate);
    if (calendar.view === 'day') newDate.setDate(newDate.getDate() + 1);
    else if (calendar.view === 'week') newDate.setDate(newDate.getDate() + 7);
    else if (calendar.view === 'month') newDate.setMonth(newDate.getMonth() + 1);
    else newDate.setDate(newDate.getDate() + 7);
    calendar.setSelectedDate(newDate);
  };

  const navigateToday = () => {
    calendar.setSelectedDate(new Date());
  };

  const getDateLabel = () => {
    const { selectedDate, view } = calendar;
    const opts = {};
    
    if (view === 'day') {
      return selectedDate.toLocaleDateString(undefined, { 
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' 
      });
    } else if (view === 'week') {
      const start = new Date(selectedDate);
      const dayOfWeek = start.getDay();
      start.setDate(start.getDate() - dayOfWeek);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      
      if (start.getMonth() === end.getMonth()) {
        return `${start.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} - ${end.getDate()}, ${start.getFullYear()}`;
      }
      return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } else if (view === 'month') {
      return selectedDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    return 'Upcoming Events';
  };

  const handleQuickAdd = async () => {
    if (!quickAddText.trim()) return;
    // Parse quick add text (basic implementation)
    const summary = quickAddText;
    const now = new Date();
    now.setHours(now.getHours() + 1, 0, 0, 0);
    const end = new Date(now);
    end.setHours(end.getHours() + 1);
    
    await calendar.createEvent({
      summary,
      start: { dateTime: now.toISOString() },
      end: { dateTime: end.toISOString() },
    });
    setQuickAddText('');
  };

  const handleEventPress = (event) => {
    setSelectedEvent(event);
    setShowEventModal(true);
  };

  // Render settings modal (defined early so it's available for not-connected state)
  const renderSettingsModal = () => (
    <Modal
      visible={calendar.showSettings}
      animationType="slide"
      transparent
      onRequestClose={() => calendar.setShowSettings(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.settingsModal}>
          <View style={styles.settingsHeader}>
            <Text style={styles.settingsTitle}>Calendar Settings</Text>
            <TouchableOpacity onPress={() => calendar.setShowSettings(false)}>
              <Ionicons name="close" size={24} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.settingsBody}>
            {/* Connection Status */}
            <View style={styles.settingsSection}>
              <Text style={styles.sectionTitle}>Connection</Text>
              <View style={[styles.connectionStatus, calendar.connected && styles.connectionStatusConnected]}>
                <View style={[styles.statusDot, calendar.connected && styles.statusDotConnected]} />
                <Text style={[styles.connectionText, calendar.connected && styles.connectionTextConnected]}>
                  {calendar.connected ? 'Connected to Google Calendar' : 'Not connected'}
                </Text>
              </View>
            </View>

            {/* Calendars */}
            {calendar.calendars.length > 0 && (
              <View style={styles.settingsSection}>
                <Text style={styles.sectionTitle}>Calendars</Text>
                {calendar.calendars.map(cal => {
                  const isSelected = calendar.settings.selectedCalendars.includes(cal.id);
                  return (
                    <TouchableOpacity
                      key={cal.id}
                      style={styles.calendarItem}
                      onPress={() => calendar.toggleCalendar(cal.id)}
                    >
                      <View style={[
                        styles.calendarCheckbox,
                        { borderColor: cal.backgroundColor || '#039be5' },
                        isSelected && { backgroundColor: cal.backgroundColor || '#039be5' }
                      ]}>
                        {isSelected && <Ionicons name="checkmark" size={12} color="#fff" />}
                      </View>
                      <Text style={styles.calendarName}>{cal.summary}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  // Render event modal
  const renderEventModal = () => (
    <Modal
      visible={showEventModal}
      animationType="slide"
      transparent
      onRequestClose={() => setShowEventModal(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.eventModal}>
          <View style={styles.eventModalHeader}>
            <Text style={styles.eventModalTitle}>Event Details</Text>
            <TouchableOpacity onPress={() => setShowEventModal(false)}>
              <Ionicons name="close" size={24} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>
          {selectedEvent && (
            <ScrollView style={styles.eventModalBody}>
              <Text style={styles.eventName}>{selectedEvent.summary}</Text>
              <View style={styles.eventDetailRow}>
                <Ionicons name="time-outline" size={16} color={COLORS.textMuted} />
                <Text style={styles.eventDetailText}>{formatEventTime(selectedEvent)}</Text>
              </View>
              {selectedEvent.location && (
                <View style={styles.eventDetailRow}>
                  <Ionicons name="location-outline" size={16} color={COLORS.textMuted} />
                  <Text style={styles.eventDetailText}>{selectedEvent.location}</Text>
                </View>
              )}
              {selectedEvent.description && (
                <View style={styles.eventDescription}>
                  <Text style={styles.eventDescriptionText}>{selectedEvent.description}</Text>
                </View>
              )}
              {(selectedEvent.hangoutLink || selectedEvent.conferenceData) && (
                <TouchableOpacity style={styles.joinBtn}>
                  <Ionicons name="videocam" size={16} color={COLORS.background} />
                  <Text style={styles.joinBtnText}>Join Video Call</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );

  // Render empty/not connected state
  if (!calendar.connected) {
    return (
      <SafeAreaView style={styles.container} edges={['left', 'right']}>
        <View style={styles.emptyState}>
          <Ionicons name="calendar-outline" size={64} color={COLORS.textMuted} />
          <Text style={styles.emptyTitle}>Connect Your Calendar</Text>
          <Text style={styles.emptyDesc}>
            Link your Google Calendar to view and manage your schedule, meetings, and events.
          </Text>
          <TouchableOpacity 
            style={styles.connectBtn}
            onPress={() => calendar.setShowSettings(true)}
          >
            <Text style={styles.connectBtnText}>Connect Google Calendar</Text>
          </TouchableOpacity>
        </View>
        {renderSettingsModal()}
      </SafeAreaView>
    );
  }

  // Render agenda view
  const renderAgendaView = () => {
    const sortedDates = Object.keys(calendar.eventsByDate).sort((a, b) => 
      new Date(a).getTime() - new Date(b).getTime()
    );
    const today = new Date().toDateString();

    return (
      <FlatList
        data={sortedDates}
        keyExtractor={date => date}
        contentContainerStyle={styles.agendaContent}
        refreshControl={
          <RefreshControl
            refreshing={calendar.loading}
            onRefresh={calendar.loadEvents}
            tintColor={COLORS.primary}
          />
        }
        renderItem={({ item: dateKey }) => {
          const isToday = dateKey === today;
          const events = calendar.eventsByDate[dateKey];
          const date = new Date(dateKey);

          return (
            <View style={styles.agendaDay}>
              <View style={[styles.agendaDateRow, isToday && styles.agendaDateRowToday]}>
                <Text style={[styles.agendaDate, isToday && styles.agendaDateToday]}>
                  {date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                </Text>
                {isToday && <View style={styles.todayBadge}><Text style={styles.todayBadgeText}>Today</Text></View>}
              </View>
              {events.map(event => {
                const cal = calendar.calendars.find(c => c.id === event.calendarId);
                const color = getEventColor(event, cal);
                const inProgress = isEventInProgress(event);

                return (
                  <TouchableOpacity
                    key={event.id}
                    style={[
                      styles.agendaEvent,
                      { borderLeftColor: color.bg },
                      inProgress && styles.agendaEventInProgress
                    ]}
                    onPress={() => handleEventPress(event)}
                  >
                    <View style={styles.agendaEventTime}>
                      <Text style={styles.agendaEventTimeText}>{formatEventTime(event)}</Text>
                    </View>
                    <View style={styles.agendaEventContent}>
                      <Text style={styles.agendaEventTitle}>{event.summary}</Text>
                      {event.location && (
                        <View style={styles.agendaEventDetail}>
                          <Ionicons name="location-outline" size={12} color={COLORS.textMuted} />
                          <Text style={styles.agendaEventDetailText}>{event.location}</Text>
                        </View>
                      )}
                      {(event.hangoutLink || event.conferenceData) && (
                        <View style={styles.agendaEventDetail}>
                          <Ionicons name="videocam-outline" size={12} color={COLORS.textMuted} />
                          <Text style={styles.agendaEventDetailText}>Video call</Text>
                        </View>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyAgenda}>
            <Text style={styles.emptyAgendaText}>No upcoming events</Text>
          </View>
        }
      />
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="calendar" size={24} color={COLORS.primary} />
          <Text style={styles.headerTitle}>Schedule</Text>
        </View>
        <TouchableOpacity 
          style={styles.settingsBtn}
          onPress={() => calendar.setShowSettings(true)}
        >
          <Ionicons name="settings-outline" size={20} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      {/* Navigation */}
      <View style={styles.navBar}>
        <View style={styles.navLeft}>
          <TouchableOpacity style={styles.navBtn} onPress={navigatePrev}>
            <Ionicons name="chevron-back" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.todayBtn} onPress={navigateToday}>
            <Text style={styles.todayBtnText}>Today</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.navBtn} onPress={navigateNext}>
            <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
          <Text style={styles.dateLabel}>{getDateLabel()}</Text>
        </View>
        <View style={styles.viewToggle}>
          {['agenda', 'day', 'week'].map(v => (
            <TouchableOpacity
              key={v}
              style={[styles.viewBtn, calendar.view === v && styles.viewBtnActive]}
              onPress={() => calendar.setView(v)}
            >
              <Text style={[styles.viewBtnText, calendar.view === v && styles.viewBtnTextActive]}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Upcoming Mini Section */}
      {calendar.upcomingEvents.length > 0 && (
        <View style={styles.upcomingSection}>
          <Text style={styles.sectionLabel}>Coming Up</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.upcomingScroll}>
            {calendar.upcomingEvents.map(event => {
              const cal = calendar.calendars.find(c => c.id === event.calendarId);
              const color = getEventColor(event, cal);
              const inProgress = isEventInProgress(event);

              return (
                <TouchableOpacity
                  key={event.id}
                  style={[styles.upcomingCard, { borderLeftColor: color.bg }, inProgress && styles.upcomingCardInProgress]}
                  onPress={() => handleEventPress(event)}
                >
                  <Text style={styles.upcomingTime}>{formatEventTime(event)}</Text>
                  <Text style={styles.upcomingTitle} numberOfLines={1}>{event.summary}</Text>
                  {event.location && (
                    <Text style={styles.upcomingLocation} numberOfLines={1}><Ionicons name="location-outline" size={11} color={COLORS.textMuted} /> {event.location}</Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Content */}
      {calendar.loading && calendar.events.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
        </View>
      ) : (
        renderAgendaView()
      )}

      {/* Quick Add */}
      <View style={styles.quickAdd}>
        <TextInput
          style={styles.quickAddInput}
          placeholder="Quick add: 'Meeting tomorrow 3pm'"
          placeholderTextColor={COLORS.textMuted}
          value={quickAddText}
          onChangeText={setQuickAddText}
          onSubmitEditing={handleQuickAdd}
        />
        <TouchableOpacity 
          style={[styles.quickAddBtn, !quickAddText.trim() && styles.quickAddBtnDisabled]}
          onPress={handleQuickAdd}
          disabled={!quickAddText.trim()}
        >
          <Text style={styles.quickAddBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      {renderSettingsModal()}
      {renderEventModal()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.text,
  },
  settingsBtn: {
    padding: 8,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    borderRadius: 8,
  },

  // Navigation
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  navLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  navBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 8,
  },
  todayBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 8,
  },
  todayBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  dateLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
    marginLeft: 8,
    flex: 1,
  },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    padding: 4,
  },
  viewBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  viewBtnActive: {
    backgroundColor: COLORS.primary,
  },
  viewBtnText: {
    fontSize: 12,
    fontWeight: '500',
    color: COLORS.textMuted,
  },
  viewBtnTextActive: {
    color: COLORS.background,
  },

  // Upcoming
  upcomingSection: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  upcomingScroll: {
    paddingHorizontal: 16,
    gap: 10,
  },
  upcomingCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 8,
    borderLeftWidth: 3,
    padding: 10,
    minWidth: 140,
    maxWidth: 200,
  },
  upcomingCardInProgress: {
    backgroundColor: COLORS.primaryDim,
  },
  upcomingTime: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.primary,
    marginBottom: 2,
  },
  upcomingTitle: {
    fontSize: 13,
    fontWeight: '500',
    color: COLORS.text,
  },
  upcomingLocation: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 2,
  },

  // Agenda
  agendaContent: {
    padding: 16,
  },
  agendaDay: {
    marginBottom: 20,
  },
  agendaDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
    marginBottom: 12,
  },
  agendaDateRowToday: {
    borderBottomColor: COLORS.primaryMuted,
  },
  agendaDate: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  agendaDateToday: {
    color: COLORS.primary,
  },
  todayBadge: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  todayBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.background,
  },
  agendaEvent: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 10,
    borderLeftWidth: 4,
    padding: 12,
    marginBottom: 8,
  },
  agendaEventInProgress: {
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  agendaEventTime: {
    minWidth: 70,
    marginRight: 12,
  },
  agendaEventTimeText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  agendaEventContent: {
    flex: 1,
  },
  agendaEventTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: COLORS.text,
    marginBottom: 4,
  },
  agendaEventDetail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  agendaEventDetailText: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  emptyAgenda: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyAgendaText: {
    fontSize: 14,
    color: COLORS.textMuted,
  },

  // Quick Add
  quickAdd: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  quickAddInput: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 13,
    color: COLORS.text,
  },
  quickAddBtn: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    justifyContent: 'center',
  },
  quickAddBtnDisabled: {
    opacity: 0.5,
  },
  quickAddBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.background,
  },

  // Empty State
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: COLORS.textMuted,
    marginTop: 24,
    marginBottom: 8,
  },
  emptyDesc: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: 'center',
    maxWidth: 300,
    marginBottom: 24,
  },
  connectBtn: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  connectBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.background,
  },

  // Loading
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Modals
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsModal: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    borderRadius: 16,
    width: '90%',
    maxWidth: 500,
    maxHeight: '80%',
  },
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  settingsTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.text,
  },
  settingsBody: {
    padding: 16,
  },
  settingsSection: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.primary,
    marginBottom: 12,
  },
  connectionStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
    borderRadius: 8,
  },
  connectionStatusConnected: {
    backgroundColor: 'rgba(34,197,94,0.1)',
    borderColor: 'rgba(34,197,94,0.3)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ef4444',
  },
  statusDotConnected: {
    backgroundColor: '#22c55e',
  },
  connectionText: {
    fontSize: 14,
    color: '#ef4444',
  },
  connectionTextConnected: {
    color: '#22c55e',
  },
  calendarItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  calendarCheckbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarName: {
    fontSize: 14,
    color: COLORS.text,
    flex: 1,
  },

  // Event Modal
  eventModal: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    borderRadius: 16,
    width: '90%',
    maxWidth: 500,
    maxHeight: '70%',
  },
  eventModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  eventModalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  eventModalBody: {
    padding: 16,
  },
  eventName: {
    fontSize: 20,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 16,
  },
  eventDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  eventDetailText: {
    fontSize: 14,
    color: COLORS.textMuted,
  },
  eventDescription: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  eventDescriptionText: {
    fontSize: 14,
    color: COLORS.text,
    lineHeight: 20,
  },
  joinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 16,
  },
  joinBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.background,
  },
});

export default ScheduleScreen;

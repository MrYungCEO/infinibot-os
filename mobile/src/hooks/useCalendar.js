/**
 * useCalendar — Google Calendar integration hook
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CALENDAR_STORAGE_KEY = 'infinibot-calendar-settings';

export function useCalendar(gateway) {
  const [events, setEvents] = useState([]);
  const [calendars, setCalendars] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // View state
  const [view, setView] = useState('agenda'); // agenda | day | week | month
  const [selectedDate, setSelectedDate] = useState(new Date());
  
  // Settings
  const [settings, setSettings] = useState({
    accessToken: '',
    refreshToken: '',
    tokenExpiry: 0,
    selectedCalendars: [],
    defaultCalendarId: '',
    weekStartsOn: 0, // 0 = Sunday
  });
  const [connected, setConnected] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Load settings from storage
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const stored = await AsyncStorage.getItem(CALENDAR_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setSettings(parsed);
        setConnected(!!parsed.accessToken);
      }
    } catch (e) {
      console.error('Failed to load calendar settings:', e);
    }
  };

  const saveSettings = async (newSettings) => {
    try {
      await AsyncStorage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify(newSettings));
      setSettings(newSettings);
      setConnected(!!newSettings.accessToken);
    } catch (e) {
      console.error('Failed to save calendar settings:', e);
    }
  };

  const loadCalendars = useCallback(async () => {
    if (!settings.accessToken) return;
    setLoading(true);
    try {
      const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
        headers: { Authorization: `Bearer ${settings.accessToken}` },
      });
      const data = await res.json();
      if (data.items) {
        setCalendars(data.items);
        // Set default calendars if none selected
        if (settings.selectedCalendars.length === 0) {
          const primary = data.items.find(c => c.primary);
          if (primary) {
            const newSettings = {
              ...settings,
              selectedCalendars: [primary.id],
              defaultCalendarId: primary.id,
            };
            saveSettings(newSettings);
          }
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [settings]);

  const loadEvents = useCallback(async () => {
    if (!settings.accessToken || settings.selectedCalendars.length === 0) return;
    setLoading(true);
    setError(null);
    
    try {
      // Calculate time range based on view
      const start = new Date(selectedDate);
      const end = new Date(selectedDate);
      
      if (view === 'day') {
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
      } else if (view === 'week') {
        const day = start.getDay();
        start.setDate(start.getDate() - day + settings.weekStartsOn);
        start.setHours(0, 0, 0, 0);
        end.setDate(start.getDate() + 6);
        end.setHours(23, 59, 59, 999);
      } else if (view === 'month') {
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        end.setMonth(end.getMonth() + 1);
        end.setDate(0);
        end.setHours(23, 59, 59, 999);
      } else {
        // Agenda - next 14 days
        start.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() + 14);
        end.setHours(23, 59, 59, 999);
      }

      const allEvents = [];
      
      for (const calId of settings.selectedCalendars) {
        const params = new URLSearchParams({
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '100',
        });
        
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
          { headers: { Authorization: `Bearer ${settings.accessToken}` } }
        );
        const data = await res.json();
        
        if (data.items) {
          data.items.forEach(event => {
            allEvents.push({ ...event, calendarId: calId });
          });
        }
      }
      
      // Sort by start time
      allEvents.sort((a, b) => {
        const aTime = new Date(a.start?.dateTime || a.start?.date).getTime();
        const bTime = new Date(b.start?.dateTime || b.start?.date).getTime();
        return aTime - bTime;
      });
      
      setEvents(allEvents);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [settings, selectedDate, view]);

  const createEvent = useCallback(async (eventData) => {
    if (!settings.accessToken) return null;
    setLoading(true);
    try {
      const calId = eventData.calendarId || settings.defaultCalendarId;
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(eventData),
        }
      );
      const data = await res.json();
      if (data.id) {
        setEvents(prev => [...prev, { ...data, calendarId: calId }].sort((a, b) => {
          const aTime = new Date(a.start?.dateTime || a.start?.date).getTime();
          const bTime = new Date(b.start?.dateTime || b.start?.date).getTime();
          return aTime - bTime;
        }));
        return data;
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
    return null;
  }, [settings]);

  const deleteEvent = useCallback(async (eventId, calendarId) => {
    if (!settings.accessToken) return false;
    setLoading(true);
    try {
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${settings.accessToken}` },
        }
      );
      setEvents(prev => prev.filter(e => e.id !== eventId));
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [settings]);

  const toggleCalendar = useCallback((calendarId) => {
    const selected = new Set(settings.selectedCalendars);
    if (selected.has(calendarId)) {
      selected.delete(calendarId);
    } else {
      selected.add(calendarId);
    }
    saveSettings({ ...settings, selectedCalendars: Array.from(selected) });
  }, [settings]);

  // Load data when settings change
  useEffect(() => {
    if (connected) {
      loadCalendars();
    }
  }, [connected]);

  useEffect(() => {
    if (connected && settings.selectedCalendars.length > 0) {
      loadEvents();
    }
  }, [connected, settings.selectedCalendars, selectedDate, view]);

  // Group events by date for agenda view
  const eventsByDate = useMemo(() => {
    const groups = {};
    events.forEach(event => {
      const dateKey = new Date(event.start?.dateTime || event.start?.date).toDateString();
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(event);
    });
    return groups;
  }, [events]);

  // Upcoming events (next 5)
  const upcomingEvents = useMemo(() => {
    const now = Date.now();
    return events
      .filter(e => new Date(e.start?.dateTime || e.start?.date).getTime() >= now - 60 * 60 * 1000)
      .slice(0, 5);
  }, [events]);

  return {
    events,
    calendars,
    loading,
    error,
    view,
    setView,
    selectedDate,
    setSelectedDate,
    settings,
    saveSettings,
    connected,
    showSettings,
    setShowSettings,
    eventsByDate,
    upcomingEvents,
    loadCalendars,
    loadEvents,
    createEvent,
    deleteEvent,
    toggleCalendar,
    clearError: () => setError(null),
  };
}

// Helper functions
export function formatEventTime(event) {
  if (!event.start) return '';
  if (event.start.date && !event.start.dateTime) return 'All day';
  const start = new Date(event.start.dateTime);
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  const timeOpts = { hour: 'numeric', minute: '2-digit' };
  if (end) {
    return `${start.toLocaleTimeString([], timeOpts)} - ${end.toLocaleTimeString([], timeOpts)}`;
  }
  return start.toLocaleTimeString([], timeOpts);
}

export function isEventInProgress(event) {
  if (!event.start?.dateTime) return false;
  const now = Date.now();
  const start = new Date(event.start.dateTime).getTime();
  const end = event.end?.dateTime ? new Date(event.end.dateTime).getTime() : start + 60 * 60 * 1000;
  return now >= start && now <= end;
}

export function getEventColor(event, calendar) {
  const colorMap = {
    '1': '#7986cb', '2': '#33b679', '3': '#8e24aa', '4': '#e67c73',
    '5': '#f6c026', '6': '#f5511d', '7': '#039be5', '8': '#616161',
    '9': '#3f51b5', '10': '#0b8043', '11': '#d60000',
  };
  const colorId = event.colorId || calendar?.colorId;
  const bg = colorMap[colorId] || calendar?.backgroundColor || '#039be5';
  // Determine if text should be light or dark
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const fg = luminance > 0.5 ? '#000' : '#fff';
  return { bg, fg };
}

import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, Image, Text, StyleSheet, Platform, TouchableOpacity, ActivityIndicator, Linking } from 'react-native';
import * as ExpoNotifications from 'expo-notifications';
import {
  registerForPushNotificationsAsync,
  openSystemNotificationSettings,
} from './src/services/notifications';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

// Screens
import { ChatScreen } from './src/screens/ChatScreen';
import { GlassesScreen } from './src/screens/GlassesScreen';
import { KanbanScreen } from './src/screens/KanbanScreen';
import AutonomyScreen from './src/screens/AutonomyScreen';
import TaskActivityScreen from './src/screens/TaskActivityScreen';
import { NotesScreen } from './src/screens/NotesScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { WorkflowsScreen } from './src/screens/WorkflowsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { VideoScreen } from './src/screens/VideoScreen';
import { ResearchScreen } from './src/screens/ResearchScreen';
import { ScheduleScreen } from './src/screens/ScheduleScreen';
import { LeadsScreen } from './src/screens/LeadsScreen';
import { ClientsScreen } from './src/screens/ClientsScreen';
import { BusinessCommandCenter } from './src/screens/BusinessCommandCenter';
import { ExecutiveCommandCenterScreen } from './src/screens/ExecutiveCommandCenterScreen';
import { OperationsCommandCenterScreen } from './src/screens/OperationsCommandCenterScreen';
import { OpsAgentsScreen } from './src/screens/OpsAgentsScreen';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { AgencyControlCenterScreen } from './src/screens/AgencyControlCenterScreen';
import { DatabasesScreen } from './src/screens/DatabasesScreen';
import { CreditsScreen } from './src/screens/CreditsScreen';
import { BusinessProfileScreen } from './src/screens/BusinessProfileScreen';
import { IncomeStreamsScreen } from './src/screens/IncomeStreamsScreen';
import { CustomerProfileScreen } from './src/screens/CustomerProfileScreen';
import { AgentsScreen } from './src/screens/AgentsScreen';
import { CronScreen } from './src/screens/CronScreen';
import { MemoryScreen } from './src/screens/MemoryScreen';
import { NeuralMeshScreen } from './src/screens/NeuralMeshScreen';
import { MeshGamificationScreen } from './src/screens/MeshGamificationScreen';
import { FederationDirectoryScreen } from './src/screens/FederationDirectoryScreen';
import { TerminalsScreen } from './src/screens/TerminalsScreen';
import { HardwareScreen } from './src/screens/HardwareScreen';
import { CampaignsScreen } from './src/screens/CampaignsScreen';
import { DisciplineScreen } from './src/screens/DisciplineScreen';
import { DisciplineBlockDetailScreen } from './src/screens/discipline/DisciplineBlockDetailScreen';
import { DisciplineSettingsScreen } from './src/screens/discipline/DisciplineSettingsScreen';
import { DisciplineLogScreen } from './src/screens/discipline/DisciplineLogScreen';
import { NotificationsCenterScreen } from './src/screens/NotificationsCenterScreen';
import { NotificationDetailScreen } from './src/screens/NotificationDetailScreen';
import { NotificationsPreferencesScreen } from './src/screens/NotificationsPreferencesScreen';
import { ReportsScreen } from './src/screens/ReportsScreen';
import { OversightScreen } from './src/screens/OversightScreen';
import { WorkspaceScreen } from './src/screens/workspace/WorkspaceScreen';
import { AgencyDailyScreen } from './src/screens/agency/AgencyDailyScreen';
import { AgencyOperationsScreen } from './src/screens/agency/AgencyOperationsScreen';
import { AgencyTopologyScreen } from './src/screens/agency/AgencyTopologyScreen';
import { ProductCatalogScreen } from './src/screens/products/ProductCatalogScreen';
import { WhiteboardScreen } from './src/screens/whiteboard/WhiteboardScreen';
import { ContentPagesScreen } from './src/screens/content/ContentPagesScreen';
import { ScriptEditorScreen } from './src/screens/content/ScriptEditorScreen';
import { ContentGenerationScreen } from './src/screens/content/ContentGenerationScreen';
import { ContentIntelScreen } from './src/screens/content/ContentIntelScreen';
import { CMOChatScreen } from './src/screens/content/CMOChatScreen';
import { TrendsScreen } from './src/screens/content/TrendsScreen';
import GridScreen from './src/screens/GridScreen';
import WebSurfaceScreen from './src/screens/WebSurfaceScreen';
import { PluginsScreen } from './src/screens/PluginsScreen';
import { ApprovalsScreen } from './src/screens/ApprovalsScreen';
import { ConnectionsScreen } from './src/screens/ConnectionsScreen';
import { ConnectionChooserScreen } from './src/screens/ConnectionChooserScreen';
import { InfiniCallScreen } from './src/screens/InfiniCallScreen';
import { lockPortrait } from './src/infini/orientation';
import { IdeasScreen } from './src/screens/IdeasScreen';
import { KnowledgeGraphScreen } from './src/screens/KnowledgeGraphScreen';
// Native group-A pages (were web-routed through WebSurfaceModal).
import { LearnScreen } from './src/screens/learn/LearnScreen';
import { InboxScreen } from './src/screens/inbox/InboxScreen';
import { CommsScreen } from './src/screens/comms/CommsScreen';
import { DocumentsScreen } from './src/screens/documents/DocumentsScreen';
import { VaultScreen } from './src/screens/vault/VaultScreen';
import { GoalsPhasesScreen } from './src/screens/goals/GoalsPhasesScreen';

// Connection profiles (cloud / self-hosted), plugins, deep links
import { CloudAuthProvider } from './src/connection/CloudAuth';
import { loadProfiles, getActiveProfile, subscribeProfiles, saveAndActivateProfile } from './src/connection/profile-store';
import { makeSelfHostedProfile, buildConnectAuth, buildCredentialOffer } from './src/connection/connection-logic';
import { probeGateway } from './src/connection/probe';
import { suggestWebConnection, bakedGatewayUrl, bakedGatewaySecret } from './src/connection/web-origin';
import { ConnectionBanner } from './src/components/ConnectionBanner';
import { usePluginSync, getPluginList, subscribePlugins } from './src/plugins/plugin-store';
import { resolveDeepLink, deepLinkFromNotificationData } from './src/navigation/deep-links';
import { setDeepLinkHandler, openDeepLink } from './src/navigation/deep-link-dispatcher';

// Components
import { FloatingDock, DOCK_BOTTOM_SPACE } from './src/components/FloatingDock';
import { NotificationBanner } from './src/components/NotificationBanner';
import { Launchpad } from './src/components/Launchpad';
import { navigateToScreen, openVoice, SCREEN_SECTIONS, flattenScreens } from './src/navigation/screen-registry';
import { derivePluginSections, mergeCatalogue, NATIVE_PLUGIN_PAGES } from './src/plugins/plugin-nav';
import { FederationTransferDrawer } from './src/components/FederationTransferDrawer';
import { MoreScreen } from './src/screens/MoreScreen';
import { navHeaderOptions } from './src/navigation/NavHeader';
import { screenErrorLayout, tabScreenLayout } from './src/components/ScreenErrorBoundary';

// KIS Phase 1 business objects (Wave M1 parity). These live in the Business
// stack; the gateway serves opportunity.*/product.*/decision.*/risk.*/
// commitment.*/person.*/objrel.* after the restart that registers them, and the
// screens show an explanatory empty/error state until then.
import { OpportunitiesScreen } from './src/screens/OpportunitiesScreen';
import { ProductsScreen } from './src/screens/ProductsScreen';
import { DecisionsScreen } from './src/screens/DecisionsScreen';
import { RisksScreen } from './src/screens/RisksScreen';
import { CommitmentsScreen } from './src/screens/CommitmentsScreen';
import { PeopleScreen } from './src/screens/PeopleScreen';

// Font loading
import { useFonts } from './src/hooks/useFonts';

// Hooks
import { useGateway } from './src/hooks/useGateway';
import { useChatSync } from './src/chat/useChatSync';
import { useNotifications } from './src/hooks/useNotifications';
import { COLORS } from './src/constants/theme';
import { ThemeProvider } from './src/theme/ThemeProvider';
import { AmbientBackground } from './src/components/AmbientBackground';
import { getNotionApiKey } from './src/utils/storage';
import { setNotionApiKey as setNotionServiceApiKey } from './src/services/notionApi';

// Portrait everywhere; only the Infini call screen unlocks rotation (see src/infini/orientation.js).
void lockPortrait();

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// ============================================================
// Stack Navigators
// ============================================================

// Discipline Stack
function DisciplineStackScreen({ gateway }) {
  return (
    <Stack.Navigator
      screenLayout={screenErrorLayout}
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Stack.Screen name="DisciplineMain">
        {(props) => <DisciplineScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="DisciplineBlockDetail" options={{ presentation: 'modal' }}>
        {(props) => <DisciplineBlockDetailScreen {...props} />}
      </Stack.Screen>
      <Stack.Screen name="DisciplineSettings" options={{ presentation: 'modal' }}>
        {(props) => <DisciplineSettingsScreen {...props} />}
      </Stack.Screen>
      <Stack.Screen name="DisciplineLog" options={{ presentation: 'modal' }}>
        {(props) => <DisciplineLogScreen {...props} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

// Autonomy Stack
function AutonomyStackScreen({ gateway }) {
  return (
    <Stack.Navigator screenLayout={screenErrorLayout} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }}>
      <Stack.Screen name="AutonomyMain">
        {(props) => <AutonomyScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="TaskActivity">
        {(props) => <TaskActivityScreen {...props} gateway={gateway} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

// Dashboard Stack — full Command Center dashboard (replaces the old Business
// tab). Home is the new DashboardScreen; the legacy BusinessCommandCenter is
// kept and reachable via the dashboard's "Command" tile so nothing is lost.
// All the original business sub-screens (CRM, Leads, Budget, etc.) remain
// registered here so the dashboard's quick-nav tiles still resolve.
function DashboardStackScreen({ gateway }) {
  return (
    <Stack.Navigator
      screenLayout={screenErrorLayout}
      screenOptions={{
        headerShown: true,
        ...navHeaderOptions,
        contentStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Stack.Screen name="DashboardHome" options={{ headerTitle: 'Dashboard', headerShown: false }}>
        {(props) => <DashboardScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="BusinessCommandCenter" options={{ headerTitle: 'Command Center', headerShown: false }}>
        {(props) => <BusinessCommandCenter {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="BusinessProfile" options={{ headerTitle: 'Business Profile' }}>
        {(props) => <BusinessProfileScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Leads" options={{ headerTitle: 'Lead Generation' }}>
        {(props) => <LeadsScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Clients" options={{ headerTitle: 'CRM' }}>
        {(props) => <ClientsScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Schedule" options={{ headerTitle: 'Schedule' }}>
        {(props) => <ScheduleScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Databases" options={{ headerTitle: 'Notion Databases' }}>
        {(props) => <DatabasesScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="IncomeStreams" options={{ headerTitle: 'Income Streams' }}>
        {(props) => <IncomeStreamsScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="CustomerProfile" options={{ headerTitle: 'Customer Profile' }}>
        {(props) => <CustomerProfileScreen {...props} gateway={gateway} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

// Business Stack — the "Business" tab. Home is the AgencyControlCenter (full
// Agency Operations control center, 1:1 with the web "Business" nav group).
// The native agency sub-screens it routes to are registered here so the hub's
// tiles push in-stack; the heavy web surfaces open via the root WebSurfaceModal.
function BusinessStackScreen({ gateway }) {
  return (
    <Stack.Navigator
      screenLayout={screenErrorLayout}
      screenOptions={{
        headerShown: true,
        ...navHeaderOptions,
        contentStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Stack.Screen name="AgencyControlCenter" options={{ headerShown: false }}>
        {(props) => <AgencyControlCenterScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Clients" options={{ headerTitle: 'CRM' }}>
        {(props) => <ClientsScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Kanban" options={{ headerTitle: 'Projects & Kanban' }}>
        {(props) => <KanbanScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Databases" options={{ headerTitle: 'Notion Databases' }}>
        {(props) => <DatabasesScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="IncomeStreams" options={{ headerTitle: 'Business Income' }}>
        {(props) => <IncomeStreamsScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="BusinessProfile" options={{ headerTitle: 'Business Profile' }}>
        {(props) => <BusinessProfileScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="BusinessCommandCenter" options={{ headerTitle: 'Command Center', headerShown: false }}>
        {(props) => <BusinessCommandCenter {...props} gateway={gateway} />}
      </Stack.Screen>

      {/* KIS Phase 1 business objects. headerShown:false — each renders its own
          <AppHeader>. Appended at the end of the stack per MASTER §11. */}
      <Stack.Screen name="Opportunities" options={{ headerTitle: 'Opportunities', headerShown: false }}>
        {(props) => <OpportunitiesScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="ProductRegistry" options={{ headerTitle: 'Product Registry', headerShown: false }}>
        {(props) => <ProductsScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Decisions" options={{ headerTitle: 'Decisions', headerShown: false }}>
        {(props) => <DecisionsScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Risks" options={{ headerTitle: 'Risks', headerShown: false }}>
        {(props) => <RisksScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Commitments" options={{ headerTitle: 'Commitments', headerShown: false }}>
        {(props) => <CommitmentsScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="People" options={{ headerTitle: 'People', headerShown: false }}>
        {(props) => <PeopleScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      {/* KIS Phase 1 command centers (§15-§21). Each renders its own AppHeader. */}
      <Stack.Screen name="ExecutiveCommandCenter" options={{ headerTitle: 'Executive Command Center', headerShown: false }}>
        {(props) => <ExecutiveCommandCenterScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="OperationsCommandCenter" options={{ headerTitle: 'Operations Command Center', headerShown: false }}>
        {(props) => <OperationsCommandCenterScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="OpsAgents" options={{ headerTitle: 'Ops Agents', headerShown: false }}>
        {(props) => <OpsAgentsScreen {...props} gateway={gateway} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

// Knowledge Stack (Library, Graph, Notes, Research, Ideas)
function KnowledgeStackScreen({ gateway }) {
  return (
    <Stack.Navigator
      screenLayout={screenErrorLayout}
      screenOptions={{ 
        headerShown: true,
        ...navHeaderOptions,
        contentStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Stack.Screen name="KnowledgeHome" options={{ headerTitle: 'Knowledge', headerShown: false }}>
        {(props) => <LibraryScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Notes" options={{ headerTitle: 'Notes' }}>
        {(props) => <NotesScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Research" options={{ headerTitle: 'Research' }}>
        {(props) => <ResearchScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Ideas" options={{ headerTitle: 'Ideas' }}>
        {(props) => <IdeasScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      {/* Native knowledge graph (same graph.global.snapshot data as the web
          /knowledge-graph). Renders its own header + gesture root. */}
      <Stack.Screen name="KnowledgeGraph" options={{ headerTitle: 'Knowledge Graph', headerShown: false }}>
        {(props) => <KnowledgeGraphScreen {...props} gateway={gateway} />}
      </Stack.Screen>
      <Stack.Screen name="Workflows" options={{ headerTitle: 'Workflows', headerShown: false }}>
        {(props) => <WorkflowsScreen {...props} gateway={gateway} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

// ============================================================
// Navigation Theme & Icons
// ============================================================

const navTheme = {
  dark: true,
  colors: {
    primary: COLORS.primary,
    // Transparent so the app-wide AmbientBackground shows through every
    // navigator surface. Individual screens supply their own panel chrome.
    background: 'transparent',
    card: COLORS.surface,
    text: COLORS.text,
    border: COLORS.border,
    notification: COLORS.primary,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' },
    medium: { fontFamily: 'System', fontWeight: '500' },
    bold: { fontFamily: 'System', fontWeight: '700' },
    heavy: { fontFamily: 'System', fontWeight: '900' },
  },
};

// ============================================================
// Main Tab Navigator
// ============================================================

function MainTabs({ gateway, notifications }) {
  return (
    <Tab.Navigator
      // FloatingDock replaces the built-in tab bar entirely
      tabBar={(props) => <FloatingDock {...props} />}
      screenLayout={tabScreenLayout}
      screenOptions={{
        // FloatingDock is the tab bar (custom `tabBar`, so no tabBarStyle here:
        // FloatingDock reads tabBarStyle.display === 'none' as "this screen is
        // immersive" — e.g. the Knowledge Graph in landscape — and a global
        // default of 'none' hid the dock on every tab).
        ...navHeaderOptions,
        // Reserve space so tab content isn't hidden under the floating dock
        contentStyle: { paddingBottom: DOCK_BOTTOM_SPACE },
      }}
    >
      {/* Chat renders its own header (chats drawer, agent switcher, new chat)
          and manages its own keyboard / composer layout. */}
      <Tab.Screen
        name="Chat"
        options={{ title: 'Chat', headerShown: false, contentStyle: { paddingBottom: 0 } }}
      >
        {(props) => <ChatScreen {...props} gateway={gateway} />}
      </Tab.Screen>

      <Tab.Screen
        name="Board"
        options={{ title: 'Board', headerTitle: 'Board' }}
      >
        {(props) => <KanbanScreen {...props} gateway={gateway} />}
      </Tab.Screen>
      
      <Tab.Screen
        name="Dashboard"
        options={{ title: 'Dashboard', headerShown: false }}
      >
        {(props) => <DashboardStackScreen {...props} gateway={gateway} />}
      </Tab.Screen>

      <Tab.Screen
        name="Business"
        options={{ title: 'Business', headerShown: false }}
      >
        {(props) => <BusinessStackScreen {...props} gateway={gateway} />}
      </Tab.Screen>

      {/* Dock voice button (the gold ∞). Route name kept as 'VoiceCall' so saved
          dock layouts still find it. Tapping it opens the InfiniBot call page
          over the current tab. */}
      <Tab.Screen
        name="VoiceCall"
        options={{ title: 'Voice', headerTitle: 'Voice', headerShown: false }}
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            e.preventDefault();
            openVoice(navigation);
          },
        })}
      >
        {() => null}
      </Tab.Screen>

      <Tab.Screen
        name="Knowledge"
        options={{ title: 'Knowledge', headerShown: false }}
      >
        {(props) => <KnowledgeStackScreen {...props} gateway={gateway} />}
      </Tab.Screen>
      
      <Tab.Screen
        name="More"
        options={{ title: 'More', headerTitle: 'More' }}
      >
        {(props) => <MoreScreen {...props} gateway={gateway} notifications={notifications} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

// ============================================================
// Root Navigator (Tabs + Modals)
// ============================================================

function RootNavigator({ gateway, notifications, onAddConnection, onEditConnection }) {
  return (
    <Stack.Navigator screenLayout={screenErrorLayout} screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MainTabs">
        {(props) => <MainTabs {...props} gateway={gateway} notifications={notifications} />}
      </Stack.Screen>

      {/* Modal Screens */}
      <Stack.Group screenOptions={{ presentation: 'modal', headerShown: true, ...navHeaderOptions }}>
        <Stack.Screen
          name="TerminalsModal"
          options={{
            headerTitle: 'Terminals',
            headerShown: false,
            gestureEnabled: false,
            fullScreenGestureEnabled: false,
          }}
        >
          {(props) => <TerminalsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="FederationDirectoryModal" options={{ headerTitle: 'Federation Directory', headerShown: false }}>
          {(props) => <FederationDirectoryScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="NeuralMeshModal" options={{ headerTitle: 'Agent Mesh', headerShown: false, presentation: 'fullScreenModal' }}>
          {(props) => <NeuralMeshScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="GridModal" options={{ headerShown: false, presentation: 'fullScreenModal' }}>
          {(props) => <GridScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        {/* Generic full-screen host for web control-UI routes the app has no
            native screen for (the native pages win via navigation/web-link.js
            and the deep-link table). Params: { path, title }. */}
        <Stack.Screen name="WebSurfaceModal" options={{ headerShown: false, presentation: 'fullScreenModal' }}>
          {(props) => <WebSurfaceScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        {/* The InfiniBot call page: the character face, local voice calls,
            quick voice capture (notes / ideas / tasks / projects / logs). */}
        <Stack.Screen name="InfiniCallModal" options={{ headerShown: false, presentation: 'fullScreenModal', gestureEnabled: false }}>
          {(props) => <InfiniCallScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="MeshGamificationModal" options={{ headerTitle: 'Mesh Progression' }}>
          {(props) => <MeshGamificationScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="AgentsModal" options={{ headerTitle: 'Agents' }}>
          {(props) => <AgentsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="CronModal" options={{ headerTitle: 'Scheduled' }}>
          {(props) => <CronScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="WorkflowsModal" options={{ headerTitle: 'Workflows', headerShown: false }}>
          {(props) => <WorkflowsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="MemoryModal" options={{ headerTitle: 'Memory' }}>
          {(props) => <MemoryScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="GlassesModal" options={{ headerShown: false }}>
          {(props) => <GlassesScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="VideoModal" options={{ headerTitle: 'Video' }}>
          {(props) => <VideoScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="ActivityModal" options={{ headerShown: false }}>
          {(props) => <TaskActivityScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="AutonomyModal" options={{ headerTitle: 'Autonomy', headerShown: false }}>
          {(props) => <AutonomyStackScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="SettingsModal" options={{ headerTitle: 'Settings' }}>
          {(props) => <SettingsScreen {...props} gateway={gateway} notifications={notifications} />}
        </Stack.Screen>
        <Stack.Screen name="HardwareModal" options={{ headerTitle: 'Hardware', headerShown: false }}>
          {(props) => <HardwareScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="CampaignsModal" options={{ headerTitle: 'Campaigns', headerShown: false }}>
          {(props) => <CampaignsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="DisciplineModal" options={{ headerTitle: 'Discipline', headerShown: false }}>
          {(props) => <DisciplineStackScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="NotificationsModal" options={{ headerTitle: 'Notifications', headerShown: false }}>
          {(props) => <NotificationsCenterScreen {...props} gateway={gateway} notifications={notifications} />}
        </Stack.Screen>
        <Stack.Screen name="NotificationDetailModal" options={{ headerTitle: 'Alert Detail', headerShown: false }}>
          {(props) => <NotificationDetailScreen {...props} gateway={gateway} pushToken={notifications?.expoPushToken} />}
        </Stack.Screen>
        <Stack.Screen name="NotificationsPrefsModal" options={{ headerTitle: 'Notification Preferences', headerShown: false }}>
          {(props) => <NotificationsPreferencesScreen {...props} gateway={gateway} pushToken={notifications?.expoPushToken} />}
        </Stack.Screen>
        <Stack.Screen name="CreditsModal" options={{ headerTitle: 'Credits & Usage' }}>
          {(props) => <CreditsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="ReportsModal" options={{ headerTitle: 'Reports', headerShown: false }}>
          {(props) => <ReportsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="OversightModal" options={{ headerTitle: 'Oversight', headerShown: false }}>
          {(props) => <OversightScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        {/* Native pages that replaced WebSurface routes (group B). */}
        <Stack.Screen name="WorkspaceModal" options={{ headerShown: false }}>
          {(props) => <WorkspaceScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="AgencyDailyModal" options={{ headerShown: false }}>
          {(props) => <AgencyDailyScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="AgencyOperationsModal" options={{ headerShown: false }}>
          {(props) => <AgencyOperationsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="AgencyTopologyModal" options={{ headerShown: false }}>
          {(props) => <AgencyTopologyScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="ProductCatalogModal" options={{ headerShown: false }}>
          {(props) => <ProductCatalogScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="WhiteboardModal" options={{ headerShown: false, presentation: 'fullScreenModal' }}>
          {(props) => <WhiteboardScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="PluginsModal" options={{ headerShown: false }}>
          {(props) => <PluginsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="ApprovalsModal" options={{ headerShown: false }}>
          {(props) => <ApprovalsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="ConnectionsModal" options={{ headerShown: false }}>
          {(props) => <ConnectionsScreen {...props} gateway={gateway} onAddConnection={onAddConnection} onEditConnection={onEditConnection} />}
        </Stack.Screen>
        <Stack.Screen name="ContentModal" options={{ headerTitle: 'Content Studio', headerShown: false }}>
          {(props) => <ContentPagesScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="ScriptEditorModal" options={{ headerShown: false }}>
          {(props) => <ScriptEditorScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="ContentGenerationModal" options={{ headerShown: false }}>
          {(props) => <ContentGenerationScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="ContentIntelModal" options={{ headerShown: false }}>
          {(props) => <ContentIntelScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="CMOChatModal" options={{ headerShown: false }}>
          {(props) => <CMOChatScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="TrendsModal" options={{ headerShown: false }}>
          {(props) => <TrendsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        {/* Native group-A pages: Learn, Inbox, Channels, Documents, Vault, Goals & Phases. */}
        <Stack.Screen name="LearnModal" options={{ headerShown: false }}>
          {(props) => <LearnScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="InboxModal" options={{ headerShown: false }}>
          {(props) => <InboxScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="CommsModal" options={{ headerShown: false }}>
          {(props) => <CommsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="DocumentsModal" options={{ headerShown: false }}>
          {(props) => <DocumentsScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="VaultModal" options={{ headerShown: false }}>
          {(props) => <VaultScreen {...props} gateway={gateway} />}
        </Stack.Screen>
        <Stack.Screen name="GoalsModal" options={{ headerShown: false }}>
          {(props) => <GoalsPhasesScreen {...props} gateway={gateway} />}
        </Stack.Screen>
      </Stack.Group>
    </Stack.Navigator>
  );
}

/**
 * "Push notifications are off" strip above the app. It takes the top safe-area
 * inset itself (so it never sits under the status bar / notch) and hands the
 * screens below a zero top inset, so their headers do not pad twice.
 */
function PushBannerLayout({ visible, onDismiss, children }) {
  const insets = useSafeAreaInsets();
  const below = useMemo(() => ({ ...insets, top: 0 }), [insets]);
  // Same tree shape whether or not the strip shows, so dismissing it never
  // remounts the navigator.
  return (
    <View style={{ flex: 1 }}>
      {visible ? (
        <>
          <View style={[pushStyles.banner, { paddingTop: insets.top + 8, paddingLeft: insets.left + 16, paddingRight: insets.right + 6 }]}>
            <TouchableOpacity
              style={pushStyles.bannerMain}
              onPress={() => openSystemNotificationSettings()}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Push notifications are off. Open system settings"
            >
              <Ionicons name="notifications-off" size={16} color={COLORS.primary} />
              <Text style={pushStyles.bannerText}>Push notifications are off — tap to enable in Settings</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onDismiss} style={pushStyles.bannerClose} accessibilityRole="button" accessibilityLabel="Dismiss">
              <Ionicons name="close" size={16} color={COLORS.primary} />
            </TouchableOpacity>
          </View>
        </>
      ) : null}
      <SafeAreaInsetsContext.Provider value={visible ? below : insets}>{children}</SafeAreaInsetsContext.Provider>
    </View>
  );
}

const pushStyles = StyleSheet.create({
  bannerMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  bannerClose: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 4,
    backgroundColor: COLORS.primaryDim,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primaryMuted,
  },
  bannerText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.primary,
  },
});

// ============================================================
// Main App
// ============================================================

export default function App() {
  // Clerk (InfiniBot Cloud sign-in) must wrap everything, including the
  // first-run connection chooser. No-op in builds without a cloud config.
  return (
    <CloudAuthProvider>
      <AppShell />
    </CloudAuthProvider>
  );
}

/**
 * The `gateway` object every screen receives.
 *
 * useGateway() returns a new object on every render, and dozens of hooks use
 * `gateway` as an effect / callback dependency — so each root re-render (a
 * streamed chat token, a notification, …) re-created their loaders and
 * re-fetched. One screen turned that into an endless request loop.
 *
 * This hands out ONE object per connection status. Its fields are getters over
 * the latest values, so reads are always current (and `{...gateway}` copies
 * current values), but its identity only changes when the socket connects or
 * drops — the one moment screens are meant to reload.
 */
function useStableGateway(live) {
  const ref = useRef(live);
  ref.current = live;
  return useMemo(() => {
    const out = {};
    for (const key of Object.keys(ref.current)) {
      Object.defineProperty(out, key, { enumerable: true, get: () => ref.current[key] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.status]);
}

function AppShell() {
  // null = still loading profiles; false = no active connection → chooser.
  const [isAuthenticated, setIsAuthenticated] = useState(null);
  const [activeProfileKey, setActiveProfileKey] = useState(null);
  const [chooser, setChooser] = useState({ open: false, pairing: null });
  // Web export: the connection derived from the page origin / build env (prefills the chooser).
  const [webSuggestion, setWebSuggestion] = useState(null);
  const [navReady, setNavReady] = useState(false);
  // The navigator unmounts while the chooser is up; wait for onReady again.
  useEffect(() => { if (chooser.open) setNavReady(false); }, [chooser.open]);
  const [pushDenied, setPushDenied] = useState(false);
  const [inAppItems, setInAppItems] = useState([]);
  const { fontsLoaded, fontError } = useFonts();
  const liveGateway = useGateway();
  // The chat model (same sessions as the web chat) lives at the root so it
  // keeps receiving live events while other tabs are open.
  const chat = useChatSync(liveGateway);
  // "Open this session" from anywhere (mesh, agent sheet, alerts) lands in Chat.
  const gateway = useStableGateway({ ...liveGateway, chat, switchSession: chat.openSession });
  const navigationRef = useRef(null);

  // plugins.list → dynamic More/Launchpad sections; refetched on every
  // (re)connect, cached per gateway for cold-start deep links.
  usePluginSync(gateway, activeProfileKey);

  const handleInAppNotify = useCallback((item) => {
    setInAppItems((prev) => [...prev, item]);
  }, []);

  useEffect(() => {
    checkExistingAuth();
    // Switching / removing a profile (Connections screen) re-evaluates auth.
    return subscribeProfiles(async () => {
      const p = await getActiveProfile();
      if (!p) gatewayRef.current?.disconnect?.();
      setActiveProfileKey(p ? `${p.id}|${p.gatewayUrl}` : null);
      setIsAuthenticated(Boolean(p));
    });
  }, []);

  // Connect when there is no socket — but never bypass a scheduled backoff
  // retry, and never retry a credential the gateway rejected (the banner asks
  // the user to fix it instead of hammering the gateway once a second).
  useEffect(() => {
    if (isAuthenticated && liveGateway.status === 'disconnected' && !liveGateway.reconnectPending && !liveGateway.authFailure) {
      gateway.connect();
    }
  }, [isAuthenticated, liveGateway.status, liveGateway.reconnectPending, liveGateway.authFailure]);

  // The saved profile failed auth and this build carries credentials for the
  // same host (EXPO_PUBLIC_GATEWAY_URL/_TOKEN) → offer them in one tap.
  const [credentialOffer, setCredentialOffer] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!liveGateway.authFailure) { setCredentialOffer(null); return undefined; }
    getActiveProfile().then((p) => {
      if (!alive) return;
      setCredentialOffer(buildCredentialOffer({
        profile: p, failure: liveGateway.authFailure, bakedUrl: bakedGatewayUrl(), bakedSecret: bakedGatewaySecret(),
      }));
    });
    return () => { alive = false; };
  }, [liveGateway.authFailure]);

  const applyBuildCredentials = useCallback(async () => {
    if (!credentialOffer) return { ok: false };
    const res = await probeGateway(credentialOffer.gatewayUrl, buildConnectAuth(credentialOffer));
    if (!res.ok) return res;
    await saveAndActivateProfile(credentialOffer);
    gateway.connect();
    return res;
  }, [credentialOffer, gateway]);

  const editActiveConnection = useCallback(async () => {
    const p = await getActiveProfile();
    setChooser({ open: true, pairing: null, edit: p || null, failure: liveGateway.authFailure || null });
  }, [liveGateway.authFailure]);

  // Register for push notifications once authenticated
  useEffect(() => {
    if (!isAuthenticated) return;
    registerForPushNotificationsAsync().then((token) => {
      if (token === null) {
        // null means simulator OR permission denied — check which
        import('expo-notifications').then(({ getPermissionsAsync }) =>
          getPermissionsAsync().then(({ status }) => {
            if (status === 'denied') setPushDenied(true);
          }),
        );
      }
    });
  }, [isAuthenticated, activeProfileKey]);

  const checkExistingAuth = async () => {
    // Initialize Notion API key
    try {
      const notionKey = await getNotionApiKey();
      if (notionKey) {
        setNotionServiceApiKey(notionKey);
      }
    } catch (err) {
      console.log('Failed to load Notion API key:', err);
    }

    // A saved connection profile (or a migrated legacy gateway URL) skips the
    // chooser; a fresh install lands on it.
    await loadProfiles();
    let p = await getActiveProfile();
    if (!p && Platform.OS === 'web') p = await autoConnectWeb();
    setActiveProfileKey(p ? `${p.id}|${p.gatewayUrl}` : null);
    setIsAuthenticated(Boolean(p));
  };

  // First open of the web export: when the gateway serves this page, connect
  // to the page's own origin (wss on https / Tailscale Serve), reusing the
  // control UI's saved password/token on this origin. Otherwise prefill the
  // chooser with what we know (origin or EXPO_PUBLIC_GATEWAY_URL).
  const autoConnectWeb = async () => {
    let suggestion = null;
    try {
      suggestion = suggestWebConnection({
        location: typeof window !== 'undefined' ? window.location : null,
        storage: typeof window !== 'undefined' ? window.localStorage : null,
        bakedUrl: bakedGatewayUrl(),
      });
    } catch {
      return null;
    }
    if (!suggestion?.gatewayUrl) return null;
    if (suggestion.secret) {
      const profile = makeSelfHostedProfile({
        gatewayUrl: suggestion.gatewayUrl,
        secret: suggestion.secret,
        authMode: suggestion.authMode,
        label: 'This gateway',
      });
      const res = await probeGateway(profile.gatewayUrl, buildConnectAuth(profile));
      if (res.ok) {
        await saveAndActivateProfile(profile);
        return profile;
      }
      setWebSuggestion({ ...suggestion, secret: '', error: res.error });
      return null;
    }
    setWebSuggestion(suggestion);
    return null;
  };

  const handleConnected = useCallback(async () => {
    const p = await getActiveProfile();
    setActiveProfileKey(p ? `${p.id}|${p.gatewayUrl}` : null);
    setChooser({ open: false, pairing: null });
    setIsAuthenticated(true);
    gateway.connect();
  }, [gateway]);

  // ── Deep links ────────────────────────────────────────────────────────
  // Every entry point (OS link cold/warm, push tap, banner, detail screen)
  // funnels into openDeepLink(); this is the one place that routes it.
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;
  const pendingPluginLinkRef = useRef(null);

  const routeDeepLink = useCallback((link) => {
    const nav = navigationRef.current;
    const target = resolveDeepLink(link, { plugins: getPluginList() });
    if (target.connect) {
      setChooser({ open: true, pairing: target.connect });
      return;
    }
    if (target.pending) {
      // A plugin page this app renders natively opens straight away — its
      // screen's PluginGate shows "turned off" if the list says so later.
      const native = target.page && NATIVE_PLUGIN_PAGES[target.page];
      if (native) {
        navigateToScreen(nav, { ...native, title: target.pluginId }, { gateway: gatewayRef.current });
        return;
      }
      // Plugin page before plugins.list is known (cold start): wait for it,
      // but never longer than 8s — then fall back to the plugin's web route.
      pendingPluginLinkRef.current = link;
      setTimeout(() => {
        if (pendingPluginLinkRef.current !== link) return;
        pendingPluginLinkRef.current = null;
        navigateToScreen(navigationRef.current, { webPath: `/${target.pluginId}${target.page ? `?section=${encodeURIComponent(target.page)}` : ''}`, title: target.pluginId, embed: true }, {});
      }, 8000);
      return;
    }
    if (target.unknown) {
      console.log('[deep-link] unhandled', link, target.reason);
      nav?.navigate('NotificationsModal', { gateway: gatewayRef.current });
      return;
    }
    navigateToScreen(nav, target, {
      gateway: gatewayRef.current,
      switchSession: (sk) => gatewayRef.current?.switchSession?.(sk),
    });
  }, []);

  // Expo-web preview hook: lets a headless harness (docs/mobile/SURFACE_AUDIT.md)
  // open any catalogue entry or route without tapping through the UI.
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const entries = () => {
      const list = getPluginList();
      return flattenScreens(mergeCatalogue(SCREEN_SECTIONS, list ? derivePluginSections(list) : null));
    };
    globalThis.__infinibotNav = {
      entries,
      open: (key) => navigateToScreen(
        navigationRef.current,
        entries().find((e) => e.key === key),
        { gateway: gatewayRef.current, switchSession: (sk) => gatewayRef.current?.switchSession?.(sk) },
      ),
      navigate: (name, params) => navigationRef.current?.navigate(name, params, { pop: true }),
      home: () => navigationRef.current?.navigate('MainTabs', { screen: 'Chat' }, { pop: true }),
      link: (url) => openDeepLink(url),
      status: () => gatewayRef.current?.status,
    };
    return () => { delete globalThis.__infinibotNav; };
  }, []);

  // Replay a pending plugin link as soon as the plugin list arrives.
  useEffect(() => subscribePlugins((st) => {
    const link = pendingPluginLinkRef.current;
    if (link && st.list) {
      pendingPluginLinkRef.current = null;
      routeDeepLink(link);
    }
  }), [routeDeepLink]);

  // The dispatcher queues links until the navigator is mounted and we are
  // connected to a gateway; `connect` links are handled even before that.
  useEffect(() => {
    if (navReady && isAuthenticated) {
      setDeepLinkHandler(routeDeepLink);
      return () => setDeepLinkHandler(null);
    }
    setDeepLinkHandler((link) => {
      const t = resolveDeepLink(link);
      if (t.connect) setChooser({ open: true, pairing: t.connect });
      else setTimeout(() => openDeepLink(link), 400); // re-queue until ready
    });
    return () => setDeepLinkHandler(null);
  }, [navReady, isAuthenticated, routeDeepLink]);

  // OS-level links: infinibot://… and https://<host>/m/… (App Links).
  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      // Expo web: the "initial URL" is just the address the app was loaded from.
      // Only its /m/<route> form is a deep link — anything else (/, ?query)
      // used to open a blank web-page host on boot.
      if (Platform.OS === 'web' && !/^https?:\/\/[^/]+\/m\//i.test(url || '')) return;
      if (url) openDeepLink(url);
    }).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => openDeepLink(url));
    // Cold start from a push tap: the response listener is not attached yet
    // when the OS delivers it, so read the last response once.
    ExpoNotifications.getLastNotificationResponseAsync?.()
      .then((resp) => {
        const data = resp?.notification?.request?.content?.data;
        const link = deepLinkFromNotificationData(data);
        if (link) openDeepLink(link);
      })
      .catch(() => {});
    return () => sub.remove();
  }, []);

  // Notification handlers
  const handleNotificationReceived = useCallback((notification) => {
    console.log('Notification received:', notification.request.content);
  }, []);

  // Warm push tap (useNotifications owns the single response listener).
  const handleNotificationTapped = useCallback((data) => {
    const link = deepLinkFromNotificationData(data);
    if (link) openDeepLink(link);
    else navigationRef.current?.navigate('MainTabs', { screen: 'Chat' }, { pop: true });
  }, []);

  const notifications = useNotifications({
    sendToGateway: gateway.sendReq,
    subscribeEvent: gateway.subscribeEvent,
    onNotificationReceived: handleNotificationReceived,
    onNotificationTapped: handleNotificationTapped,
    onInAppNotify: handleInAppNotify,
  });

  // Font loading or initial auth check
  if (!fontsLoaded || isAuthenticated === null) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: COLORS.background, justifyContent: 'center', alignItems: 'center' }}>
          <Image source={require('./assets/infinibot-logo.png')} style={{ width: 64, height: 64, opacity: 0.6 }} resizeMode="contain" />
          <ActivityIndicator color={COLORS.primary} size="small" style={{ marginTop: 16 }} />
        </View>
        <StatusBar style="light" />
      </SafeAreaProvider>
    );
  }

  // No connection yet (first run), or adding / pairing a new one.
  if (!isAuthenticated || chooser.open) {
    return (
      <SafeAreaProvider>
        <ConnectionChooserScreen
          onConnected={handleConnected}
          onCancel={isAuthenticated ? () => setChooser({ open: false, pairing: null }) : undefined}
          onDeleted={() => setChooser({ open: false, pairing: null })}
          initialPairing={chooser.pairing}
          editProfile={chooser.edit || null}
          authFailure={chooser.failure || null}
          initialSuggestion={chooser.pairing || chooser.edit ? null : webSuggestion}
        />
        <StatusBar style="light" />
      </SafeAreaProvider>
    );
  }

  // Main app — wrap with ThemeProvider so the master device's palette
  // flows into every screen, and use AnimatedBackground (driven by the
  // master's selected background style) in place of TerminalBackground.
  return (
    <SafeAreaProvider>
      <ThemeProvider gateway={gateway}>
        <AmbientBackground>
          <PushBannerLayout visible={pushDenied} onDismiss={() => setPushDenied(false)}>
            <NavigationContainer theme={navTheme} ref={navigationRef} onReady={() => setNavReady(true)}>
              <RootNavigator gateway={gateway} notifications={notifications} onAddConnection={() => setChooser({ open: true })}
                onEditConnection={(p) => setChooser({ open: true, pairing: null, edit: p, failure: null })} />
            </NavigationContainer>
          </PushBannerLayout>
          <ConnectionBanner
            status={liveGateway.status}
            lastError={liveGateway.lastError}
            authFailure={liveGateway.authFailure}
            credentialOffer={credentialOffer}
            onUseBuildCredentials={applyBuildCredentials}
            onEdit={editActiveConnection}
            onRetry={() => gateway.connect()}
            onChange={() => setChooser({ open: true, pairing: null })}
          />
          <NotificationBanner
            gateway={gateway}
            navigationRef={navigationRef}
            extraItems={inAppItems}
            onExtraItemsConsumed={() => setInAppItems([])}
          />
          {/* Search-centric page switcher. Mounted at the root so it can
              overlay any route and drive the root navigator directly. */}
          <Launchpad
            navigationRef={navigationRef}
            gateway={gateway}
            notifications={notifications}
          />
          <FederationTransferDrawer gateway={gateway} />
        </AmbientBackground>
      </ThemeProvider>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}

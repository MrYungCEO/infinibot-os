/**
 * Platform features registry — shared between funnel nodes and content pages.
 *
 * These feature configs define the sections + fields rendered in
 * the per-platform feature modal. Keep this file pure data; no render code.
 */

export interface FeatureConfigField {
  id: string;
  label: string;
  type: 'text' | 'password' | 'checkbox' | 'select' | 'textarea' | 'number';
  placeholder?: string;
  options?: { value: string; label: string }[];
  hint?: string;
  required?: boolean;
}

export interface PlatformFeatureSection {
  title: string;
  fields: FeatureConfigField[];
}

export interface PlatformFeature {
  id: string;
  name: string;
  icon: string;
  description: string;
  requiredIntegration?: string;
  configFields?: FeatureConfigField[];
  sections?: PlatformFeatureSection[];
}

export const PLATFORM_FEATURES: Record<string, PlatformFeature[]> = {
  instagram: [
    {
      id: 'instagram_graph',
      name: 'INSTAGRAM ANALYTICS',
      icon: 'analytics',
      description: 'Live reach, impressions, and follower metrics via Instagram Graph API',
      requiredIntegration: 'instagram-graph',
      sections: [
        {
          title: 'DATA SYNC',
          fields: [
            { id: 'sync_period', label: 'SYNC_PERIOD', type: 'select', options: [
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'manual', label: 'Manual only' },
            ], hint: 'How often to pull fresh metrics' },
            { id: 'include_stories', label: 'INCLUDE_STORIES', type: 'checkbox', hint: 'Include story metrics in analytics' },
            { id: 'include_reels', label: 'INCLUDE_REELS', type: 'checkbox', hint: 'Include Reel metrics' },
          ]
        },
      ]
    },
    {
      id: 'dm_flows',
      name: 'DM AUTOMATION',
      icon: 'messaging',
      description: 'Automated DM responses via ManyChat',
      requiredIntegration: 'manychat',
      sections: [
        {
          title: 'MANYCHAT CONNECTION',
          fields: [
            { id: 'manychat_api_key', label: 'API_KEY', type: 'password', placeholder: 'Enter ManyChat API key', required: true, hint: 'Get from ManyChat → Settings → API' },
          ]
        },
        {
          title: 'DEFAULT FLOW',
          fields: [
            { id: 'default_flow_id', label: 'FLOW_ID', type: 'text', placeholder: 'content20250101_abc123', hint: 'Flow namespace to trigger on new DMs' },
            { id: 'welcome_message', label: 'WELCOME_MSG', type: 'textarea', placeholder: 'Hey {{first_name}}! Thanks for reaching out...', hint: 'Sent before flow starts' },
          ]
        },
        {
          title: 'TRIGGERS',
          fields: [
            { id: 'trigger_on_follow', label: 'ON_NEW_FOLLOW', type: 'checkbox', hint: 'Send DM when someone follows' },
            { id: 'trigger_on_story_reply', label: 'ON_STORY_REPLY', type: 'checkbox', hint: 'Trigger flow on story replies' },
            { id: 'trigger_on_mention', label: 'ON_MENTION', type: 'checkbox', hint: 'Trigger when mentioned in stories' },
          ]
        },
        {
          title: 'AUTO-TAGGING',
          fields: [
            { id: 'auto_tag', label: 'AUTO_TAG', type: 'text', placeholder: 'ig_lead, funnel_entry', hint: 'Tags to apply (comma-separated)' },
            { id: 'custom_field_source', label: 'SOURCE_FIELD', type: 'text', placeholder: 'source', hint: 'Custom field to store entry source' },
          ]
        },
      ]
    },
    {
      id: 'comment_triggers',
      name: 'COMMENT AUTOMATION',
      icon: 'messaging',
      description: 'Auto-DM when users comment specific keywords',
      requiredIntegration: 'manychat',
      sections: [
        {
          title: 'TRIGGER KEYWORDS',
          fields: [
            { id: 'trigger_keywords', label: 'KEYWORDS', type: 'textarea', placeholder: 'INFO\nLINK\nFREE\nPRICE', hint: 'One keyword per line (case-insensitive)' },
            { id: 'exact_match', label: 'EXACT_MATCH', type: 'checkbox', hint: 'Require exact match (vs contains)' },
          ]
        },
        {
          title: 'RESPONSE FLOW',
          fields: [
            { id: 'response_flow_id', label: 'FLOW_ID', type: 'text', placeholder: 'content20250101_comment', hint: 'Flow to send when keyword detected' },
            { id: 'response_delay', label: 'DELAY_SECONDS', type: 'number', placeholder: '5', hint: 'Wait before sending (0-60)' },
          ]
        },
        {
          title: 'POST FILTER',
          fields: [
            { id: 'post_filter', label: 'POST_FILTER', type: 'select', options: [
              { value: 'all', label: 'All Posts' },
              { value: 'recent', label: 'Last 10 Posts' },
              { value: 'specific', label: 'Specific Posts Only' },
            ]},
            { id: 'specific_post_ids', label: 'POST_IDS', type: 'textarea', placeholder: 'Post IDs (one per line)', hint: 'Only if POST_FILTER = specific' },
          ]
        },
      ]
    },
    {
      id: 'link_in_bio',
      name: 'LINK IN BIO',
      icon: 'link',
      description: 'Track bio link clicks with UTM parameters',
      sections: [
        {
          title: 'LINK SETTINGS',
          fields: [
            { id: 'bio_url', label: 'DESTINATION_URL', type: 'text', placeholder: 'https://yoursite.com/offer', required: true },
            { id: 'short_link', label: 'SHORT_LINK', type: 'text', placeholder: 'https://link.yoursite.com/ig', hint: 'Optional branded short link' },
          ]
        },
        {
          title: 'UTM TRACKING',
          fields: [
            { id: 'utm_source', label: 'UTM_SOURCE', type: 'text', placeholder: 'instagram' },
            { id: 'utm_medium', label: 'UTM_MEDIUM', type: 'text', placeholder: 'social' },
            { id: 'utm_campaign', label: 'UTM_CAMPAIGN', type: 'text', placeholder: 'bio_link' },
          ]
        },
        {
          title: 'PIXEL & ANALYTICS',
          fields: [
            { id: 'fb_pixel_id', label: 'FB_PIXEL_ID', type: 'text', placeholder: '123456789012345' },
            { id: 'ga_measurement_id', label: 'GA_ID', type: 'text', placeholder: 'G-XXXXXXXXXX' },
          ]
        },
      ]
    },
    {
      id: 'story_links',
      name: 'STORY LINKS',
      icon: 'link',
      description: 'Track story link sticker clicks',
      sections: [
        {
          title: 'DEFAULT LINK',
          fields: [
            { id: 'story_default_url', label: 'DEFAULT_URL', type: 'text', placeholder: 'https://yoursite.com/story-offer' },
          ]
        },
        {
          title: 'TRACKING',
          fields: [
            { id: 'story_utm_campaign', label: 'UTM_CAMPAIGN', type: 'text', placeholder: 'story_swipeup' },
            { id: 'track_views', label: 'TRACK_VIEWS', type: 'checkbox', hint: 'Track story view → link click rate' },
          ]
        },
      ]
    },
  ],
  tiktok: [
    {
      id: 'link_in_bio',
      name: 'LINK IN BIO',
      icon: 'link',
      description: 'Track bio link clicks',
      sections: [
        {
          title: 'LINK SETTINGS',
          fields: [
            { id: 'bio_url', label: 'DESTINATION_URL', type: 'text', placeholder: 'https://yoursite.com/tiktok', required: true },
          ]
        },
        {
          title: 'UTM TRACKING',
          fields: [
            { id: 'utm_source', label: 'UTM_SOURCE', type: 'text', placeholder: 'tiktok' },
            { id: 'utm_medium', label: 'UTM_MEDIUM', type: 'text', placeholder: 'social' },
            { id: 'utm_campaign', label: 'UTM_CAMPAIGN', type: 'text', placeholder: 'bio_link' },
          ]
        },
      ]
    },
    {
      id: 'video_cta',
      name: 'VIDEO CTAs',
      icon: 'offer',
      description: 'Track video call-to-action conversions',
      sections: [
        {
          title: 'CTA TRACKING',
          fields: [
            { id: 'cta_type', label: 'CTA_TYPE', type: 'select', options: [
              { value: 'link_bio', label: 'Link in Bio' },
              { value: 'comment', label: 'Comment Keyword' },
              { value: 'shop', label: 'TikTok Shop' },
            ]},
            { id: 'cta_keyword', label: 'CTA_KEYWORD', type: 'text', placeholder: 'LINK', hint: 'Keyword viewers should comment' },
          ]
        },
      ]
    },
  ],
  youtube: [
    {
      id: 'description_links',
      name: 'DESCRIPTION LINKS',
      icon: 'link',
      description: 'Track video description link clicks',
      sections: [
        {
          title: 'PRIMARY LINK',
          fields: [
            { id: 'primary_url', label: 'PRIMARY_URL', type: 'text', placeholder: 'https://yoursite.com/youtube', required: true },
            { id: 'primary_label', label: 'LABEL', type: 'text', placeholder: '🔗 Get Started Free' },
          ]
        },
        {
          title: 'UTM TRACKING',
          fields: [
            { id: 'utm_source', label: 'UTM_SOURCE', type: 'text', placeholder: 'youtube' },
            { id: 'utm_medium', label: 'UTM_MEDIUM', type: 'text', placeholder: 'video' },
            { id: 'utm_campaign', label: 'UTM_CAMPAIGN', type: 'text', placeholder: 'description_link' },
          ]
        },
      ]
    },
    {
      id: 'video_cards',
      name: 'END SCREENS & CARDS',
      icon: 'offer',
      description: 'Track end screen and info card clicks',
      sections: [
        {
          title: 'END SCREEN',
          fields: [
            { id: 'endscreen_url', label: 'LINK_URL', type: 'text', placeholder: 'https://yoursite.com/offer' },
            { id: 'endscreen_cta', label: 'CTA_TEXT', type: 'text', placeholder: 'Start Free Trial' },
          ]
        },
      ]
    },
    {
      id: 'pinned_comments',
      name: 'PINNED COMMENTS',
      icon: 'messaging',
      description: 'Track pinned comment link clicks',
      sections: [
        {
          title: 'COMMENT TEMPLATE',
          fields: [
            { id: 'comment_template', label: 'TEMPLATE', type: 'textarea', placeholder: '📌 Get the free guide mentioned in this video: {{link}}' },
            { id: 'comment_link', label: 'LINK', type: 'text', placeholder: 'https://yoursite.com/guide' },
          ]
        },
      ]
    },
  ],
  linkedin: [
    {
      id: 'link_tracking',
      name: 'LINK TRACKING',
      icon: 'link',
      description: 'Track post and profile link clicks',
      sections: [
        {
          title: 'PROFILE LINK',
          fields: [
            { id: 'profile_url', label: 'DESTINATION_URL', type: 'text', placeholder: 'https://yoursite.com/linkedin', required: true },
            { id: 'utm_campaign', label: 'UTM_CAMPAIGN', type: 'text', placeholder: 'linkedin_profile' },
          ]
        },
      ]
    },
  ],
  twitter: [
    {
      id: 'link_tracking',
      name: 'LINK TRACKING',
      icon: 'link',
      description: 'Track bio and post link clicks',
      sections: [
        {
          title: 'BIO LINK',
          fields: [
            { id: 'bio_url', label: 'BIO_URL', type: 'text', placeholder: 'https://yoursite.com/twitter', required: true },
            { id: 'utm_campaign', label: 'UTM_CAMPAIGN', type: 'text', placeholder: 'twitter_bio' },
          ]
        },
      ]
    },
  ],
  blog: [
    {
      id: 'cta_tracking',
      name: 'CTA TRACKING',
      icon: 'offer',
      description: 'Track article CTA clicks and conversions',
      sections: [
        {
          title: 'PRIMARY CTA',
          fields: [
            { id: 'cta_url', label: 'CTA_URL', type: 'text', placeholder: 'https://yoursite.com/offer', required: true },
            { id: 'cta_text', label: 'CTA_TEXT', type: 'text', placeholder: 'Get Started Free' },
            { id: 'utm_campaign', label: 'UTM_CAMPAIGN', type: 'text', placeholder: 'blog_cta' },
          ]
        },
      ]
    },
  ],
  newsletter: [
    {
      id: 'email_sequence',
      name: 'EMAIL SEQUENCES',
      icon: 'messaging',
      description: 'Automated email follow-up sequences',
      sections: [
        {
          title: 'PROVIDER SETTINGS',
          fields: [
            { id: 'provider', label: 'PROVIDER', type: 'select', options: [
              { value: 'convertkit', label: 'ConvertKit' },
              { value: 'mailchimp', label: 'Mailchimp' },
              { value: 'beehiiv', label: 'Beehiiv' },
              { value: 'custom', label: 'Custom SMTP' },
            ]},
            { id: 'api_key', label: 'API_KEY', type: 'password', placeholder: 'Provider API key', required: true },
          ]
        },
      ]
    },
  ],
  podcast: [
    {
      id: 'episode_links',
      name: 'EPISODE LINKS',
      icon: 'link',
      description: 'Track show notes link clicks per episode',
      sections: [
        {
          title: 'DEFAULT LINK',
          fields: [
            { id: 'show_notes_url', label: 'SHOW_NOTES_URL', type: 'text', placeholder: 'https://yoursite.com/podcast' },
            { id: 'utm_campaign', label: 'UTM_CAMPAIGN', type: 'text', placeholder: 'podcast_notes' },
          ]
        },
      ]
    },
  ],
  facebook: [
    {
      id: 'link_in_bio',
      name: 'PAGE LINK',
      icon: 'link',
      description: 'Track Facebook page CTA button clicks',
      sections: [
        {
          title: 'CTA BUTTON',
          fields: [
            { id: 'cta_url', label: 'DESTINATION_URL', type: 'text', placeholder: 'https://yoursite.com/facebook', required: true },
            { id: 'utm_campaign', label: 'UTM_CAMPAIGN', type: 'text', placeholder: 'facebook_page' },
          ]
        },
      ]
    },
  ],
};

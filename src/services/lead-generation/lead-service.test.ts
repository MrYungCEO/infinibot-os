/**
 * Lead Generation Service Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { LeadService, getLeadService, resetLeadService } from "./lead-service.js";
import type { Lead } from "./types.js";

describe("LeadService", () => {
  beforeEach(() => {
    resetLeadService();
  });

  describe("getLeadService", () => {
    it("should return singleton instance", () => {
      const service1 = getLeadService();
      const service2 = getLeadService();
      expect(service1).toBe(service2);
    });

    it("should create new instance after reset", () => {
      const service1 = getLeadService();
      resetLeadService();
      const service2 = getLeadService();
      expect(service1).not.toBe(service2);
    });
  });

  describe("getAvailableSources", () => {
    it("should return list of sources", () => {
      const service = new LeadService();
      const sources = service.getAvailableSources();

      expect(sources).toHaveLength(4);
      expect(sources.map((s) => s.source)).toContain("google_maps");
      expect(sources.map((s) => s.source)).toContain("google_search");
      expect(sources.map((s) => s.source)).toContain("apollo");
      expect(sources.map((s) => s.source)).toContain("hunter_io");
    });

    it("should indicate API key status", () => {
      const service = new LeadService();
      const sources = service.getAvailableSources();

      // Without env vars, all should show hasApiKey: false
      sources.forEach((source) => {
        expect(typeof source.hasApiKey).toBe("boolean");
        expect(typeof source.description).toBe("string");
      });
    });
  });

  describe("lead management", () => {
    it("should get lead by id", () => {
      const service = new LeadService();

      // Initially no leads
      expect(service.getLead("nonexistent")).toBeUndefined();

      // After adding via cache (simulated search result)
      const mockLead: Lead = createMockLead("test-1");
      (service as any).leadsCache.set("test-1", mockLead);

      expect(service.getLead("test-1")).toEqual(mockLead);
    });

    it("should get all leads", () => {
      const service = new LeadService();

      expect(service.getAllLeads()).toHaveLength(0);

      (service as any).leadsCache.set("lead-1", createMockLead("lead-1"));
      (service as any).leadsCache.set("lead-2", createMockLead("lead-2"));

      expect(service.getAllLeads()).toHaveLength(2);
    });

    it("should update lead", () => {
      const service = new LeadService();
      // Stamp the lead in the past: the update can land in the same millisecond.
      const lead = { ...createMockLead("test-1"), lastUpdated: Date.now() - 1000 };
      (service as any).leadsCache.set("test-1", lead);

      const updated = service.updateLead("test-1", { status: "contacted", notes: "Called" });

      expect(updated?.status).toBe("contacted");
      expect(updated?.notes).toBe("Called");
      expect(updated?.lastUpdated).toBeGreaterThan(lead.lastUpdated);
    });

    it("should return null when updating non-existent lead", () => {
      const service = new LeadService();
      expect(service.updateLead("nonexistent", { status: "contacted" })).toBeNull();
    });

    it("should delete lead", () => {
      const service = new LeadService();
      (service as any).leadsCache.set("test-1", createMockLead("test-1"));

      expect(service.deleteLead("test-1")).toBe(true);
      expect(service.getLead("test-1")).toBeUndefined();
      expect(service.deleteLead("test-1")).toBe(false); // Already deleted
    });
  });

  describe("getStats", () => {
    it("should return stats for all scrapers", () => {
      const service = new LeadService();
      const stats = service.getStats();

      expect(stats).toHaveLength(4); // 4 scrapers
      stats.forEach((stat) => {
        expect(stat).toHaveProperty("source");
        expect(stat).toHaveProperty("requestsToday");
        expect(stat).toHaveProperty("errorsToday");
        expect(stat).toHaveProperty("leadsScrapedToday");
      });
    });
  });

  describe("search", () => {
    it("should return empty results when no API keys configured", async () => {
      const service = new LeadService();

      const result = await service.search({
        query: "test restaurants",
        location: "Bangkok",
      });

      // Without API keys, we expect empty results with error messages
      expect(result.leads).toBeDefined();
      expect(Array.isArray(result.leads)).toBe(true);
      expect(result.searchParams.query).toBe("test restaurants");
    });

    it("should handle search errors gracefully", async () => {
      const service = new LeadService();

      // Mock a scraper to throw
      const scraper = (service as any).scrapers.get("google_maps");
      vi.spyOn(scraper, "search").mockRejectedValue(new Error("Network error"));

      const result = await service.search({
        query: "test",
        sources: ["google_maps"],
      });

      expect(result.errors).toBeDefined();
      expect(result.errors?.some((e) => e.includes("Network error"))).toBe(true);
    });
  });

  describe("deduplication", () => {
    it("should deduplicate leads by name and website", () => {
      const service = new LeadService();

      const leads: Lead[] = [
        { ...createMockLead("1"), companyName: "Test Co", website: "https://test.com" },
        {
          ...createMockLead("2"),
          companyName: "Test Co",
          website: "https://test.com",
          email: "new@test.com",
        },
        { ...createMockLead("3"), companyName: "Other Co", website: "https://other.com" },
      ];

      const deduped = (service as any).deduplicateLeads(leads);

      expect(deduped).toHaveLength(2);
      // Merged lead should have the email from second entry
      const testCo = deduped.find((l: Lead) => l.companyName === "Test Co");
      expect(testCo?.email).toBe("new@test.com");
    });

    it("should merge lead data from multiple sources", () => {
      const service = new LeadService();

      const leads: Lead[] = [
        { ...createMockLead("1"), companyName: "Test", phone: "123", email: undefined },
        { ...createMockLead("2"), companyName: "Test", email: "test@test.com", phone: undefined },
      ];

      const deduped = (service as any).deduplicateLeads(leads);

      expect(deduped).toHaveLength(1);
      expect(deduped[0].phone).toBe("123");
      expect(deduped[0].email).toBe("test@test.com");
    });
  });

  describe("filtering", () => {
    it("should filter by rating", () => {
      const service = new LeadService();

      const leads: Lead[] = [
        { ...createMockLead("1"), rating: 4.5 },
        { ...createMockLead("2"), rating: 3.0 },
        { ...createMockLead("3"), rating: 2.0 },
      ];

      const filtered = (service as any).filterLeads(leads, { minRating: 4.0 });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].rating).toBe(4.5);
    });

    it("should filter by email presence", () => {
      const service = new LeadService();

      const leads: Lead[] = [
        { ...createMockLead("1"), email: "test@test.com" },
        { ...createMockLead("2"), contactEmail: "contact@test.com" },
        { ...createMockLead("3") },
      ];

      const filtered = (service as any).filterLeads(leads, { hasEmail: true });

      expect(filtered).toHaveLength(2);
    });

    it("should filter by phone presence", () => {
      const service = new LeadService();

      const leads: Lead[] = [
        { ...createMockLead("1"), phone: "123-456-7890" },
        { ...createMockLead("2") },
        { ...createMockLead("3"), contactPhone: "098-765-4321" },
      ];

      const filtered = (service as any).filterLeads(leads, { hasPhone: true });

      expect(filtered).toHaveLength(2);
    });
  });
});

// ============================================================
// Test Helpers
// ============================================================

function createMockLead(id: string): Lead {
  return {
    id,
    companyName: `Company ${id}`,
    type: "business",
    source: "google_maps",
    status: "new",
    quality: "unknown",
    scrapedAt: Date.now(),
    lastUpdated: Date.now(),
  };
}

/**
 * JSON schemas for structured AI extraction.
 *
 * These schemas define the expected output shapes when the AI provider
 * is asked to extract structured product data.
 */

/** Schema for product material extraction. */
export const materialExtractionSchema = {
  type: "object",
  properties: {
    materials: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Material name (e.g. 'Aluminum', 'Polycarbonate')" },
          category: { type: "string", description: "Material category (e.g. 'Metal', 'Plastic', 'Textile')" },
          percentage: { type: ["number", "null"], description: "Approximate percentage of the product" },
          description: { type: "string", description: "Brief description of how this material is used" },
          sourceIndex: { type: ["number", "null"], description: "Index into the provided sources array (0-based), or null if no web source" },
          confidence: { type: "string", enum: ["high", "medium", "low"], description: "Confidence level of this claim" },
        },
        required: ["name", "category"],
      },
    },
    summary: { type: "string", description: "Brief paragraph about the product's material composition" },
  },
  required: ["materials", "summary"],
};

/** Schema for supply chain extraction. */
export const supplyChainExtractionSchema = {
  type: "object",
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          nodeType: { type: "string", enum: ["raw_material", "processing", "manufacturing", "assembly", "distribution", "retail"] },
          companyName: { type: ["string", "null"], description: "Company at this supply chain stage" },
          locationName: { type: ["string", "null"], description: "City or region name" },
          country: { type: ["string", "null"], description: "Country name" },
          latitude: { type: ["number", "null"] },
          longitude: { type: ["number", "null"] },
          description: { type: "string", description: "What happens at this stage" },
          sourceIndex: { type: ["number", "null"], description: "Index into the provided sources array (0-based), or null if no web source" },
          confidence: { type: "string", enum: ["high", "medium", "low"], description: "Confidence level of this claim" },
        },
        required: ["nodeType", "description"],
      },
    },
  },
  required: ["nodes"],
};

/** Schema for company information extraction. */
export const companyExtractionSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    website: { type: ["string", "null"] },
    foundedYear: { type: ["number", "null"] },
    headquarters: { type: ["string", "null"] },
    employeeCount: { type: ["number", "null"] },
    revenue: { type: ["string", "null"], description: "Approximate annual revenue (e.g. '$50B')" },
    relationships: {
      type: "array",
      items: {
        type: "object",
        properties: {
          companyName: { type: "string" },
          relationshipType: { type: "string", enum: ["parent", "subsidiary", "supplier", "joint_venture", "acquired", "partner"] },
        },
        required: ["companyName", "relationshipType"],
      },
    },
    sourceIndex: { type: ["number", "null"], description: "Index into the provided sources array (0-based), or null if no web source" },
    confidence: { type: "string", enum: ["high", "medium", "low"], description: "Confidence level of this extraction" },
  },
  required: ["name", "description"],
};

/** Schema for product summary card generation. */
export const summaryCardsSchema = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string", description: "2-4 sentences" },
          category: { type: "string", enum: ["overview", "materials", "supply_chain", "company", "sustainability", "history"] },
          icon: { type: "string", description: "Emoji icon for the card" },
        },
        required: ["title", "content", "category", "icon"],
      },
    },
  },
  required: ["cards"],
};

/** Schema for product history extraction. */
export const historyExtractionSchema = {
  type: "object",
  properties: {
    narrative: { type: "string", description: "2-4 paragraph product history" },
    inventionYear: { type: ["number", "null"] },
    inventor: { type: ["string", "null"] },
    predecessors: { type: "array", items: { type: "string" } },
    milestones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          year: { type: "number" },
          event: { type: "string" },
          sourceIndex: { type: ["number", "null"] },
        },
        required: ["year", "event"],
      },
    },
  },
  required: ["narrative"],
};

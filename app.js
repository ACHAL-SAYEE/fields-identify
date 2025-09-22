import express from "express";
import bodyParser from "body-parser";
import { pipeline } from "@xenova/transformers";

const app = express();
app.use(bodyParser.json());

function cleanName(line) {
  if (!line) return "";
  line = line.replace(/\S+@\S+\.\S+/g, "");
  line = line.replace(/https?:\/\/\S+/g, "");
  line = line.replace(/www\.\S+/g, "");
  line = line.replace(/(\+?\d[\d\-\)\( ]{5,}\d)/g, "");
  line = line.replace(/\d+/g, "");
  const noiseWords = ["contact", "ph", "tel", "phone", "mobile"];
  noiseWords.forEach((word) => {
    line = line.replace(new RegExp("\\b" + word + "\\b", "ig"), "");
  });
  return line.replace(/\s+/g, " ").trim();
}

function isAddress(line) {
  const addressKeywords = [
    "road",
    "phase",
    "sector",
    "street",
    "extn",
    "block",
    "complex",
    "tower",
    "floor","plot"
  ];
  const hasNumbers = /\d/.test(line);
  const hasKeyword = addressKeywords.some((k) =>
    line.toLowerCase().includes(k)
  );
  return hasNumbers && hasKeyword;
}

function isDesignation(line) {
  const keywords = [
    "lead",
    "manager",
    "director",
    "chief",
    "head",
    "engineer",
    "developer",
    "designer",
    "consultant",
    "analyst",
    "specialist",
    "coordinator",
    "executive",
    "officer",
    "president",
    "vp",
    "founder",
  ];
  return keywords.some((k) => line.toLowerCase().includes(k));
}

function mergeEntities(entities, targetType = "ORG") {
  const results = [];
  let currentTokens = [];
  let currentScores = [];

  for (let e of entities) {
    if (e.entity.startsWith("B-" + targetType)) {
      if (currentTokens.length > 0) {
        results.push({
          text: currentTokens
            .join(" ")
            .replace(/\s*##/g, "")
            .replace(/\s+/g, " ")
            .trim(),
          score:
            currentScores.reduce((a, b) => a + b, 0) / currentScores.length,
        });
      }
      currentTokens = [e.word];
      currentScores = [e.score];
    } else if (e.entity.startsWith("I-" + targetType) && currentTokens.length) {
      if (e.word.startsWith("##")) {
        currentTokens[currentTokens.length - 1] += e.word.replace("##", "");
      } else {
        currentTokens.push(e.word);
      }
      currentScores.push(e.score);
    } else {
      if (currentTokens.length > 0) {
        results.push({
          text: currentTokens
            .join(" ")
            .replace(/\s*##/g, "")
            .replace(/\s+/g, " ")
            .trim(),
          score:
            currentScores.reduce((a, b) => a + b, 0) / currentScores.length,
        });
        currentTokens = [];
        currentScores = [];
      }
    }
  }

  if (currentTokens.length > 0) {
    results.push({
      text: currentTokens
        .join(" ")
        .replace(/\s*##/g, "")
        .replace(/\s+/g, " ")
        .trim(),
      score: currentScores.reduce((a, b) => a + b, 0) / currentScores.length,
    });
  }
  return results;
}
let ner;

async function initNER() {
  if (!ner) {
    console.log("Loading NER model...");
    ner = await pipeline("ner", "Xenova/bert-base-NER");
    console.log("NER model loaded.");
  }
}

async function re(ocrLines) {
  // const ner = await pipeline("ner", "Xenova/bert-base-NER");
  await initNER();
  let extracted = {
    persons: [],
    companies: [],
    locations: [],
    designations: [],
  };

  for (let line of ocrLines) {
    const result = await ner(line);
    let type;
    let score = 0;

    for (let entity of result) {
      if (entity.entity.startsWith("B-") && entity.index === 1) {
        if (entity.score > score) {
          type = entity.entity.slice(2);
          score = entity.score;
        }
      }
    }

    if (result.length !== 0 && result[0].entity === "B-LOC") {
      extracted.locations.push(line);
    } else if (isDesignation(line)) {
      extracted.designations.push(line);
    } else if (isAddress(line)) {
      extracted.locations.push(line);
    }

    switch (type) {
      case "PER":
        extracted.persons.push(line);
        break;
      case "ORG":
        extracted.companies.push(line);
        break;
    }
  }

  const companyText = extracted.companies.join(" ");
  const companyResult = await ner(companyText);

  let mergedCompanies;
  let bestCompany = "";
  let bestScore = 0;

  if (companyResult.length > 1) {
    mergedCompanies = mergeEntities(companyResult, "ORG");
    for (let c of mergedCompanies) {
      if (c.score > bestScore) {
        bestCompany = c.text;
        bestScore = c.score;
      }
    }
  }

  let resCompany;
  if (extracted.companies.length === 1) {
    resCompany = extracted.companies[0];
  } else {
    resCompany = mergedCompanies?.[0]?.text;
  }

  return {
    name: cleanName(extracted.persons[0]),
    company: resCompany,
    address: extracted.locations,
    designation: extracted.designations,
  };
}
initNER()
app.post("/extract", async (req, res) => {
  try {
    const { ocrLines } = req.body;
    if (!ocrLines || !Array.isArray(ocrLines)) {
      return res.status(400).json({ error: "ocrLines must be an array" });
    }
    const result = await re(ocrLines);
    res.json(result);
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

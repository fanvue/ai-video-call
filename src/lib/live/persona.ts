// One place for the creator's pronouns, so every prompt names the performer the same way.
import type { CreatorGender, CreatorProfile } from "./contract";

export type Persona = {
  gender: CreatorGender;
  noun: "woman" | "man";
  subject: "she" | "he";
  Subject: "She" | "He";
  object: "her" | "him";
  possessive: "her" | "his";
  Possessive: "Her" | "His";
  reflexive: "herself" | "himself";
};

const PERSONAS: Record<CreatorGender, Persona> = {
  female: {
    gender: "female",
    noun: "woman",
    subject: "she",
    Subject: "She",
    object: "her",
    possessive: "her",
    Possessive: "Her",
    reflexive: "herself",
  },
  male: {
    gender: "male",
    noun: "man",
    subject: "he",
    Subject: "He",
    object: "him",
    possessive: "his",
    Possessive: "His",
    reflexive: "himself",
  },
};

// No creator or no gender is female: every session from before male creators existed.
export const personaFor = (creator?: Pick<CreatorProfile, "gender">): Persona =>
  PERSONAS[creator?.gender ?? "female"];

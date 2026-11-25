// Jev, matching an email to a project: one choice question, an option per project.

export const EMAIL_PROJECT_QUESTION =
  "Which project is this email about? Pick the project its subject and content belong to. Past emails people filed by hand are listed under each project: an email from the same sender or on the same subject belongs with them. If it fits none of them, or is general, pick the none option.";

/** The option for an email that belongs to no project. */
export const NO_EMAIL_PROJECT = "none";

export const EMAIL_NONE_CRITERIA =
  "None of the projects: a newsletter, a personal message, or something general";

/** Longest project description and email body the classifier is given. */
const DESCRIPTION_MAX = 500;
export const EMAIL_CLASSIFY_BODY_MAX = 2000;

/** What the classifier judges a project by: its description and the emails filed under it. */
export const emailProjectCriteria = (project: {
  readonly name: string;
  readonly description: string;
  readonly examples: ReadonlyArray<{ readonly from: string; readonly subject: string }>;
}): string => {
  const description = project.description.trim();
  return [
    description === ""
      ? `The project ${project.name}`
      : `${project.name}: ${description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX - 1)}…` : description}`,
    ...(project.examples.length === 0
      ? []
      : [
          "Emails filed here before:",
          ...project.examples.map((e) => `- from ${e.from}: ${e.subject}`),
        ]),
  ].join("\n");
};

/** The email as the classifier's `message` state. */
export const emailClassifyMessage = (email: {
  readonly from: string;
  readonly subject: string;
  readonly body: string;
}): string =>
  `From: ${email.from}\nSubject: ${email.subject}\n\n${
    email.body.length > EMAIL_CLASSIFY_BODY_MAX
      ? `${email.body.slice(0, EMAIL_CLASSIFY_BODY_MAX - 1)}…`
      : email.body
  }`;

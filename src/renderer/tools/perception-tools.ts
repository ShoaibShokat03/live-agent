import type { JSONSchema } from '../../shared/types';
import { hud } from '../bridge';
import type { Perception } from '../live/perception';
import type { UiTool } from './ui-tools';

const obj = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({ type: 'object', properties, required });
const NAME: JSONSchema = { type: 'string', description: "The person's name" };

/** Camera vision + face and voice memory. */
export function perceptionTools(p: Perception): UiTool[] {
  const t = (def: Omit<UiTool, 'location'>): UiTool => ({ ...def, location: 'renderer' });
  return [
    t({
      name: 'camera_control',
      description:
        'Use the webcam. on = open the camera with a live preview and stream it to you continuously (also recognizes known faces); ' +
        'look = take one fresh camera frame now (to see the user, an object they hold up, etc.); off = close the camera.',
      parameters: obj({ action: { type: 'string', enum: ['on', 'off', 'look'] } }, ['action']),
      async run({ action }) {
        if (action === 'off') {
          p.stopCamera();
          return { camera: 'off' };
        }
        if (action === 'look') return p.look();
        await p.startCamera(true);
        return { camera: 'on', streaming: true };
      },
    }),
    t({
      name: 'identify_people',
      description: 'Who is here? Recognizes known faces in the camera view and reports who spoke last (by voiceprint).',
      parameters: obj({}),
      run: () => p.identifyPeople(),
    }),
    t({
      name: 'enroll_face',
      description:
        "Remember a person's face under a name (camera turns on automatically; they should face the camera, alone, in good light). " +
        'Call again later to add more samples and improve accuracy.',
      parameters: obj({ name: NAME }, ['name']),
      run: ({ name }) => p.enrollFace(name),
    }),
    t({
      name: 'enroll_voice',
      description:
        "Remember a person's voice under a name, from the speech JARVIS just heard. FIRST ask them to speak a few natural sentences " +
        '(about 5-10 seconds), wait until they finish, THEN call this. More enrollments (on different days) improve accuracy. ' +
        'The first use downloads a ~400 MB local voice model (one time).',
      parameters: obj({ name: NAME }, ['name']),
      timeoutMs: 180000,
      run: ({ name }) => p.enrollVoice(name),
    }),
    t({
      name: 'who_is_speaking',
      description: 'Identify who is talking right now from their voiceprint (needs voices enrolled with enroll_voice).',
      parameters: obj({}),
      run: () => p.whoIsSpeaking(),
    }),
    t({
      name: 'list_people',
      description: 'List the people JARVIS knows by face and/or voice.',
      parameters: obj({}),
      run: () => hud.people.list(),
    }),
    t({
      name: 'forget_person',
      description: "Permanently delete a person's saved face and voice data.",
      parameters: obj({ name: NAME }, ['name']),
      confirm: true,
      async run({ name }) {
        if (!(await p.forget(name))) throw new Error(`Nobody named "${name}" is saved`);
        return { forgotten: name };
      },
    }),
  ];
}

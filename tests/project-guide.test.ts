import {test,expect} from 'bun:test';
import {answerProjectQuestion} from '../frontend/project-guide.js';
test('project guide resolves model, feedback, calendar and proactivity questions',()=>{
 for(const [question,id] of [['Why use LinUCB?','bandit'],['How does it learn?','learning'],['How are calendar changes approved?','calendar'],['How do distractions affect the model?','distraction'],['What triggers proactive prompts?','proactive'],['What are the input features?','features']])expect(answerProjectQuestion(question)?.id).toBe(id);
});
test('guide returns no fabricated answer for unrelated questions or empty input',()=>{
 expect(answerProjectQuestion('What is the weather in Paris?')).toBeNull();expect(answerProjectQuestion('')).toBeNull();expect(answerProjectQuestion('<script>alert(1)</script>')).toBeNull();
});

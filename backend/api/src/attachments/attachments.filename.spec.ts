import { AttachmentsService } from './attachments.service';

describe('AttachmentsService.sanitiseFileName', () => {
  const sanitise = AttachmentsService.sanitiseFileName;

  it('keeps an ordinary filename intact', () => {
    expect(sanitise('diagnostic-log.txt')).toBe('diagnostic-log.txt');
  });

  it('strips directory components from a traversal attempt', () => {
    expect(sanitise('../../../../etc/passwd')).toBe('passwd');
    expect(sanitise('/absolute/path/report.pdf')).toBe('report.pdf');
    // Backslashes are separators on every platform, so the result is OS-independent.
    expect(sanitise('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitise('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(sanitise('mixed/..\\path/notes.txt')).toBe('notes.txt');
  });

  it('removes characters that break paths or terminals', () => {
    expect(sanitise('in:valid*name?.txt')).toBe('in_valid_name_.txt');
    expect(sanitise('bell\u0007name.txt')).toBe('bellname.txt');
  });

  it('never returns an empty name', () => {
    expect(sanitise('')).toBe('file');
    expect(sanitise('   ')).toBe('file');
    expect(sanitise('/')).toBe('file');
    expect(sanitise('\\')).toBe('file');
    expect(sanitise('uploads/..')).toBe('file');
  });

  it('caps the length', () => {
    expect(sanitise(`${'a'.repeat(400)}.txt`)).toHaveLength(200);
  });
});

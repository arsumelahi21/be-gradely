import { Role } from './role.type';

export type Actor = {
  userId: string;
  role: Role;
  schoolId: string | null;
};

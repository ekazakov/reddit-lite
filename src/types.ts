export type User = { id: number; name: string };

export type Env = { Variables: { user: User | null } };

export type PostRow = {
  id: number;
  title: string;
  body: string;
  url: string | null;
  score: number;
  comment_count: number;
  created_at: Date;
  author: string;
  my_vote: number;
};

export type CommentRow = {
  id: number;
  post_id: number;
  parent_id: number | null;
  body: string;
  like_count: number;
  created_at: Date;
  author: string;
  liked: boolean;
};

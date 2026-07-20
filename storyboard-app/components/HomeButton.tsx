
import React from 'react';
import Button from './Button';

interface HomeButtonProps {
  onClick: () => void;
}

const HomeButton: React.FC<HomeButtonProps> = ({ onClick }) => {
  return (
    <Button
      onClick={onClick}
      variant="outline"
      className="absolute top-4 right-4 sm:top-8 sm:right-8 z-10 shadow-md rounded-full px-5 py-2"
    >
      홈
    </Button>
  );
};

export default HomeButton;
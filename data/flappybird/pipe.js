class Pipe {
    constructor(x,y) {
        this.pos = {x: x, y: y};
        this.gapH = PIPE_GAP_H;
        this.width = PIPE_WIDTH;
        this.velocity = PIPE_SCROOL;

        this.hasPoint = true;

        this.topPipe = {
            x1: this.pos.x - this.width/2,
            y1: 0,
            x2: this.pos.x + this.width/2,
            y2: this.pos.y - this.gapH/2
        };
        this.bottomPipe = {
            x1: this.pos.x - this.width/2, 
            y1: this.pos.y + this.gapH/2,
            x2: this.pos.x + this.width/2,
            y2: height
        };
        
        pipes.push(this);
    }

    show(){
        push();
            noStroke();
            fill(color(PIPE_COLOR));
            rectMode(CORNER);
            rect(this.topPipe.x1, this.topPipe.y1, this.width, this.topPipe.y2);
            rect(this.bottomPipe.x1, this.bottomPipe.y1, this.width, this.bottomPipe.y2);
        pop();
    }

    debugShow(){
        push();
            noStroke();
            fill(color(255));
            rectMode(CORNER);
            rect(this.topPipe.x1, this.topPipe.y1, this.width, this.topPipe.y2);
            rect(this.bottomPipe.x1, this.bottomPipe.y1, this.width, this.bottomPipe.y2);
            /*fill(color(255,0,0));
            ellipse(this.bottomPipe.x2, this.bottomPipe.y1,20,20);*/
        pop();
    }
    
    isCollide(bird){
        //return isInside(bird.pos, this.topPipe) || isInside(bird.pos, this.bottomPipe);
        return circleRect(
            bird,
            this.topPipe
        ) || 
        circleRect(
            bird,
            this.bottomPipe
        );
    }

    update() {
        this.pos.x -= this.velocity;
        if (this.pos.x < -this.width/2){
            pipes.splice(this, 1);
            new Pipe(pipes[pipes.length-1].pos.x + PIPE_BETWEEN + PIPE_WIDTH, random(150, height-150));
        }

        if (this.hasPoint && this.pos.x < BIRD_X){
            bestScore++;
            this.hasPoint = false;    
        }


        this.topPipe = {
            x1: this.pos.x - this.width/2,
            y1: 0,
            x2: this.pos.x + this.width/2,
            y2: this.pos.y - this.gapH/2
        };
        this.bottomPipe = {
            x1: this.pos.x - this.width/2, 
            y1: this.pos.y + this.gapH/2,
            x2: this.pos.x + this.width/2,
            y2: height
        };
    }

}